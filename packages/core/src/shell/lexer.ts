import { TokenKind, type Token, type WordPart } from './types.js';

export function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    // Skip whitespace (but NOT newlines -- they become Newline tokens)
    if (input[i] === ' ' || input[i] === '\t') {
      i++;
      continue;
    }

    // Newline
    if (input[i] === '\n') {
      tokens.push({ kind: TokenKind.Newline, value: '\n', pos: i });
      i++;
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

  tokens.push({ kind: TokenKind.EOF, value: '', pos: i });
  return tokens;
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

    // Backslash escape (outside quotes)
    if (ch === '\\' && i + 1 < input.length) {
      currentText += input[i + 1];
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
      if (nc === '#' || nc === '@' || nc === '?' || /[0-9]/.test(nc)) {
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
