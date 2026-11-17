import { TokenKind, type Token, type WordPart } from './types.js';

/** A here-document whose body is read from the lines after the current one. */
interface PendingHereDoc {
  token: Token;      // the Word token that receives the body
  delimiter: string;
  stripTabs: boolean; // <<-
  quoted: boolean;    // <<'EOF' / <<"EOF" / <<\EOF: no expansion in the body
}

export interface LexResult {
  tokens: Token[];
  /** True when the input ends inside a quote or a here-document, or with a `\` line continuation. */
  incomplete: boolean;
}

export function lex(input: string): Token[] {
  return lexDetailed(input).tokens;
}

export function lexDetailed(input: string): LexResult {
  const tokens: Token[] = [];
  let i = 0;
  let pending: PendingHereDoc[] = [];
  let incomplete = false;

  while (i < input.length) {
    // Skip whitespace (but NOT newlines -- they become Newline tokens)
    if (input[i] === ' ' || input[i] === '\t') {
      i++;
      continue;
    }

    // Line continuation
    if (input[i] === '\\' && input[i + 1] === '\n') {
      i += 2;
      continue;
    }

    // Newline (then the bodies of any here-documents started on this line)
    if (input[i] === '\n') {
      tokens.push({ kind: TokenKind.Newline, value: '\n', pos: i });
      i++;
      for (const doc of pending) {
        const read = readHereDocBody(input, i, doc);
        i = read.end;
        if (!read.terminated) incomplete = true;
      }
      pending = [];
      continue;
    }

    // Here-string (<<<) and here-document (<< / <<-)
    if (input[i] === '<' && input[i + 1] === '<') {
      if (input[i + 2] === '<') {
        tokens.push({ kind: TokenKind.HereString, value: '<<<', pos: i });
        i += 3;
        continue;
      }
      const stripTabs = input[i + 2] === '-';
      tokens.push({ kind: TokenKind.HereDoc, value: stripTabs ? '<<-' : '<<', pos: i });
      i += stripTabs ? 3 : 2;
      while (input[i] === ' ' || input[i] === '\t') i++;
      const delim = readWord(input, i);
      const body: Token = { kind: TokenKind.Word, value: '', pos: i, parts: [{ text: '', quoted: 'single' }] };
      tokens.push(body);
      if (delim) {
        const parts = delim.token.parts ?? [];
        pending.push({
          token: body,
          delimiter: parts.map((p) => p.text).join(''),
          stripTabs,
          quoted: parts.some((p) => p.quoted !== 'none') || /[\\'"]/.test(input.slice(i, delim.end)),
        });
        i = delim.end;
      }
      continue;
    }

    // Comment -- skip to end of line
    if (input[i] === '#') {
      while (i < input.length && input[i] !== '\n') {
        i++;
      }
      continue;
    }

    // Operators
    const op = tryOperator(input, i);
    if (op) {
      tokens.push(op.token);
      i = op.end;
      continue;
    }

    // Word (may include quotes, escapes, $(), globs, variables)
    const word = readWord(input, i);
    if (word) {
      tokens.push(word.token);
      i = word.end;
      continue;
    }

    // Shouldn't reach here, but advance to avoid infinite loop
    i++;
  }

  // Here-documents started on the last line, with no newline after it.
  if (pending.length > 0) incomplete = true;
  if (endsInsideQuote(input) || /(^|[^\\])(\\\\)*\\$/.test(input)) incomplete = true;

  tokens.push({ kind: TokenKind.EOF, value: '', pos: i });
  return { tokens, incomplete };
}

/** Reads a here-document body starting at `pos` (the start of the line after `<<WORD`). */
function readHereDocBody(input: string, pos: number, doc: PendingHereDoc): { end: number; terminated: boolean } {
  const lines: string[] = [];
  let i = pos;
  let terminated = false;
  while (i < input.length) {
    let nl = input.indexOf('\n', i);
    if (nl === -1) nl = input.length;
    let line = input.slice(i, nl);
    i = Math.min(nl + 1, input.length);
    if (doc.stripTabs) line = line.replace(/^\t+/, '');
    if (line === doc.delimiter) {
      terminated = true;
      break;
    }
    lines.push(line);
  }
  const body = lines.length > 0 ? lines.join('\n') + '\n' : '';
  doc.token.value = body;
  doc.token.parts = doc.quoted ? [{ text: body, quoted: 'single' }] : hereDocParts(body);
  return { end: i, terminated };
}

/** An unquoted here-document body expands $VAR, ${…}, $(…) and $((…)); `\$`, `\\` and `\`` are literal. */
function hereDocParts(body: string): WordPart[] {
  const parts: WordPart[] = [];
  let text = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\' && (body[i + 1] === '$' || body[i + 1] === '\\' || body[i + 1] === '`')) {
      if (text) parts.push({ text, quoted: 'double' });
      text = '';
      parts.push({ text: body[i + 1], quoted: 'single' });
      i++;
      continue;
    }
    if (body[i] === '\\' && body[i + 1] === '\n') {
      i++;
      continue;
    }
    text += body[i];
  }
  if (text || parts.length === 0) parts.push({ text, quoted: 'double' });
  return parts;
}

/** True if the input ends inside an unclosed single or double quote (ignoring comments). */
function endsInsideQuote(input: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
    } else if (quote === '"') {
      if (ch === '\\') i++;
      else if (ch === '"') quote = null;
    } else if (ch === '\\') {
      i++;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === '#' && (i === 0 || /[\s;&|()]/.test(input[i - 1]))) {
      while (i < input.length && input[i] !== '\n') i++;
    } else if (ch === '<' && input[i + 1] === '<' && input[i + 2] !== '<') {
      // Skip here-doc bodies: their quotes don't count.
      return false;
    }
  }
  return quote !== null;
}

function tryOperator(input: string, pos: number): { token: Token; end: number } | null {
  const ch = input[pos];
  const next = input[pos + 1];

  // &> (redirect both)
  if (ch === '&' && next === '>') {
    return { token: { kind: TokenKind.RedirectAll, value: '&>', pos }, end: pos + 2 };
  }

  // && (and)
  if (ch === '&' && next === '&') {
    return { token: { kind: TokenKind.And, value: '&&', pos }, end: pos + 2 };
  }

  // & (background)
  if (ch === '&') {
    return { token: { kind: TokenKind.Amp, value: '&', pos }, end: pos + 1 };
  }

  // || (or)
  if (ch === '|' && next === '|') {
    return { token: { kind: TokenKind.Or, value: '||', pos }, end: pos + 2 };
  }

  // | (pipe)
  if (ch === '|') {
    return { token: { kind: TokenKind.Pipe, value: '|', pos }, end: pos + 1 };
  }

  // 2>&1 (dup stderr onto stdout) — must precede the 2> rule
  if (ch === '2' && next === '>' && input[pos + 2] === '&' && input[pos + 3] === '1') {
    if (pos > 0 && !isOperatorBreak(input[pos - 1])) {
      return null; // part of a larger word (e.g. foo2>&1x is not a redirect)
    }
    return { token: { kind: TokenKind.RedirectDup, value: '2>&1', pos }, end: pos + 4 };
  }

  // 1>&2 (dup stdout onto stderr) — must precede word scanning of '1'
  if (ch === '1' && next === '>' && input[pos + 2] === '&' && input[pos + 3] === '2') {
    if (pos > 0 && !isOperatorBreak(input[pos - 1])) {
      return null;
    }
    return { token: { kind: TokenKind.RedirectDup, value: '>&2', pos }, end: pos + 4 };
  }

  // 2>> (stderr append)
  if (ch === '2' && next === '>' && input[pos + 2] === '>') {
    return { token: { kind: TokenKind.RedirectErrAppend, value: '2>>', pos }, end: pos + 3 };
  }

  // 2> (stderr redirect)
  if (ch === '2' && next === '>') {
    // Only treat as redirect if not part of a larger word
    // Check what's before: if preceded by a word char, it's part of a word
    if (pos > 0 && !isOperatorBreak(input[pos - 1])) {
      return null;
    }
    return { token: { kind: TokenKind.RedirectErr, value: '2>', pos }, end: pos + 2 };
  }

  // >> (append)
  if (ch === '>' && next === '>') {
    return { token: { kind: TokenKind.RedirectAppend, value: '>>', pos }, end: pos + 2 };
  }

  // >&2 (dup stdout onto stderr) / >&1 (self-dup, no-op) — before the > rule
  if (ch === '>' && next === '&' && input[pos + 2] === '2') {
    return { token: { kind: TokenKind.RedirectDup, value: '>&2', pos }, end: pos + 3 };
  }
  if (ch === '>' && next === '&' && input[pos + 2] === '1') {
    return { token: { kind: TokenKind.RedirectDup, value: '>&1', pos }, end: pos + 3 };
  }

  // > (redirect out)
  if (ch === '>') {
    return { token: { kind: TokenKind.RedirectOut, value: '>', pos }, end: pos + 1 };
  }

  // < (redirect in)
  if (ch === '<') {
    return { token: { kind: TokenKind.RedirectIn, value: '<', pos }, end: pos + 1 };
  }

  // ;; (double semicolon -- case item terminator)
  if (ch === ';' && next === ';') {
    return { token: { kind: TokenKind.DoubleSemi, value: ';;', pos }, end: pos + 2 };
  }

  // ; (semicolon)
  if (ch === ';') {
    return { token: { kind: TokenKind.Semi, value: ';', pos }, end: pos + 1 };
  }

  // ( (left paren)
  if (ch === '(') {
    return { token: { kind: TokenKind.LParen, value: '(', pos }, end: pos + 1 };
  }

  // ) (right paren)
  if (ch === ')') {
    return { token: { kind: TokenKind.RParen, value: ')', pos }, end: pos + 1 };
  }

  return null;
}

function isOperatorBreak(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '|' || ch === '&' || ch === ';'
    || ch === '>' || ch === '<' || ch === '\n' || ch === '(' || ch === ')';
}

function isWordBreak(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '|' || ch === '&' || ch === ';'
    || ch === '>' || ch === '<' || ch === '#' || ch === '\n' || ch === '(' || ch === ')';
}

function readWord(input: string, pos: number): { token: Token; end: number } | null {
  const parts: WordPart[] = [];
  let i = pos;
  let currentText = '';
  let hasContent = false;

  while (i < input.length) {
    const ch = input[i];

    // Backslash escape (outside quotes): the next character is literal, so it is kept as a
    // quoted part (no variable, brace, glob or tilde expansion). Backslash-newline joins lines.
    if (ch === '\\' && i + 1 < input.length) {
      if (input[i + 1] === '\n') {
        i += 2;
        continue;
      }
      if (currentText) {
        parts.push({ text: currentText, quoted: 'none' });
        currentText = '';
      }
      parts.push({ text: input[i + 1], quoted: 'single' });
      i += 2;
      hasContent = true;
      continue;
    }

    // Single quote
    if (ch === "'") {
      if (currentText) {
        parts.push({ text: currentText, quoted: 'none' });
        currentText = '';
      }
      i++; // skip opening quote
      const start = i;
      while (i < input.length && input[i] !== "'") {
        i++;
      }
      parts.push({ text: input.slice(start, i), quoted: 'single' });
      if (i < input.length) i++; // skip closing quote
      hasContent = true;
      continue;
    }

    // Double quote
    if (ch === '"') {
      if (currentText) {
        parts.push({ text: currentText, quoted: 'none' });
        currentText = '';
      }
      i++; // skip opening quote
      let dqText = '';
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          const nextCh = input[i + 1];
          // Inside double quotes, only these chars are special with backslash
          if (nextCh === '"' || nextCh === '\\' || nextCh === '$' || nextCh === '`') {
            dqText += nextCh;
            i += 2;
          } else {
            dqText += '\\';
            i++;
          }
        } else if (input[i] === '$' && input[i + 1] === '(') {
          // Command substitution inside double quotes - capture raw
          const subst = readCommandSubstitution(input, i);
          dqText += subst.text;
          i = subst.end;
        } else {
          dqText += input[i];
          i++;
        }
      }
      parts.push({ text: dqText, quoted: 'double' });
      if (i < input.length) i++; // skip closing quote
      hasContent = true;
      continue;
    }

    // $(...) or $((...)) command/arithmetic substitution
    if (ch === '$' && input[i + 1] === '(') {
      const subst = readCommandSubstitution(input, i);
      currentText += subst.text;
      i = subst.end;
      hasContent = true;
      continue;
    }

    // ${...} braced variable expansion -- read until matching }
    if (ch === '$' && input[i + 1] === '{') {
      currentText += '${';
      let j = i + 2;
      let depth = 1;
      while (j < input.length && depth > 0) {
        if (input[j] === '{') depth++;
        else if (input[j] === '}') depth--;
        if (depth > 0) {
          currentText += input[j];
        }
        j++;
      }
      currentText += '}';
      i = j;
      hasContent = true;
      continue;
    }

    // $# $@ $N $? -- special variables that start with $
    if (ch === '$' && i + 1 < input.length) {
      const nc = input[i + 1];
      if (nc === '#' || nc === '@' || nc === '?' || nc === '$' || nc === '!' || /[0-9]/.test(nc)) {
        currentText += '$' + nc;
        i += 2;
        hasContent = true;
        continue;
      }
    }

    // Check for operator/break chars that end the word
    // Special case: 2> and 2>> at word start should be handled by tryOperator
    if (isWordBreak(ch)) {
      break;
    }

    // Check for redirect operators that could appear mid-stream
    if (ch === '>' || ch === '<') {
      break;
    }

    currentText += ch;
    i++;
    hasContent = true;
  }

  if (!hasContent) return null;

  if (currentText) {
    parts.push({ text: currentText, quoted: 'none' });
  }

  // Build combined value for backward compatibility
  const value = parts.map((p) => p.text).join('');

  return {
    token: { kind: TokenKind.Word, value, pos, parts },
    end: i,
  };
}

function readCommandSubstitution(input: string, pos: number): { text: string; end: number } {
  // pos points at '$'
  let i = pos + 1; // skip $

  if (input[i] !== '(') {
    return { text: '$', end: pos + 1 };
  }

  // Check for $(( -- arithmetic expansion
  if (input[i + 1] === '(') {
    // Read until matching ))
    let text = '$((';
    let j = i + 2; // skip ((
    let depth = 1;
    while (j < input.length && depth > 0) {
      if (input[j] === '(' && input[j + 1] === '(') {
        depth++;
        text += '((';
        j += 2;
      } else if (input[j] === ')' && input[j + 1] === ')') {
        depth--;
        if (depth === 0) {
          text += '))';
          j += 2;
          break;
        }
        text += '))';
        j += 2;
      } else {
        text += input[j];
        j++;
      }
    }
    return { text, end: j };
  }

  // Regular $(...) command substitution
  let depth = 0;
  let text = '$(';
  i++; // skip (
  depth = 1;

  while (i < input.length && depth > 0) {
    if (input[i] === '(') {
      depth++;
    } else if (input[i] === ')') {
      depth--;
      if (depth === 0) {
        text += ')';
        i++;
        break;
      }
    }
    text += input[i];
    i++;
  }

  return { text, end: i };
}
