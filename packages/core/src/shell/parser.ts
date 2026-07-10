import {
  TokenKind,
  type Token,
  type ScriptNode,
  type ListNode,
  type PipelineNode,
  type SimpleCommandNode,
  type RedirectionNode,
  type WordPart,
  type CompoundCommandNode,
  type IfNode,
  type ForNode,
  type WhileNode,
  type UntilNode,
  type CaseNode,
  type FunctionDefNode,
  type GroupNode,
} from './types.js';

export class ParseError extends Error {
  constructor(message: string, public pos: number) {
    super(message);
    this.name = 'ParseError';
  }
}

export function parse(tokens: Token[]): ScriptNode {
  const parser = new Parser(tokens);
  return parser.parseScript();
}

const KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi',
  'for', 'in', 'do', 'done',
  'while', 'until',
  'case', 'esac',
]);

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] ?? { kind: TokenKind.EOF, value: '', pos: -1 };
  }

  private peekAt(offset: number): Token {
    return this.tokens[this.pos + offset] ?? { kind: TokenKind.EOF, value: '', pos: -1 };
  }

  private advance(): Token {
    const token = this.peek();
    if (token.kind !== TokenKind.EOF) {
      this.pos++;
    }
    return token;
  }

  private expect(kind: TokenKind): Token {
    const token = this.peek();
    if (token.kind !== kind) {
      throw new ParseError(
        `Expected ${TokenKind[kind]} but got ${TokenKind[token.kind]} ('${token.value}')`,
        token.pos,
      );
    }
    return this.advance();
  }

  private expectWord(value: string): Token {
    const token = this.peek();
    if (token.kind !== TokenKind.Word || token.value !== value) {
      throw new ParseError(
        `Expected '${value}' but got '${token.value}'`,
        token.pos,
      );
    }
    return this.advance();
  }

  private isAtEnd(): boolean {
    return this.peek().kind === TokenKind.EOF;
  }

  private isWord(value: string): boolean {
    return this.peek().kind === TokenKind.Word && this.peek().value === value;
  }

  private skipNewlines(): void {
    while (this.peek().kind === TokenKind.Newline) {
      this.advance();
    }
  }

  parseScript(): ScriptNode {
    const lists: ListNode[] = [];

    // Skip leading separators
    this.skipSeparators();

    while (!this.isAtEnd()) {
      const prevPos = this.pos;
      lists.push(this.parseList());
      this.skipSeparators();
      // Guard against infinite loop: if no progress was made, the current token
      // is unexpected (e.g. a stray '(' from pasted JS code). Throw so the
      // caller can display an error instead of hanging the browser.
      if (this.pos === prevPos) {
        throw new ParseError(
          `unexpected token '${this.peek().value}'`,
          this.peek().pos,
        );
      }
    }

    return { type: 'script', lists };
  }

  private skipSeparators(): void {
    while (this.peek().kind === TokenKind.Semi || this.peek().kind === TokenKind.Newline) {
      this.advance();
    }
  }

  private parseList(): ListNode {
    const entries: ListNode['entries'] = [];
    let background = false;

    // First pipeline
    const firstPipeline = this.parsePipeline();
    entries.push({ pipeline: firstPipeline, connector: null });

    // Chained pipelines with && or ||
    while (this.peek().kind === TokenKind.And || this.peek().kind === TokenKind.Or) {
      const connectorToken = this.advance();
      const connector = connectorToken.value as '&&' | '||';
      // Update the previous entry's connector
      entries[entries.length - 1].connector = connector;
      this.skipNewlines();
      const pipeline = this.parsePipeline();
      entries.push({ pipeline, connector: null });
    }

    // Check for background &
    if (this.peek().kind === TokenKind.Amp) {
      this.advance();
      background = true;
    }

    return { type: 'list', entries, background };
  }

  private parsePipeline(): PipelineNode {
    let negated = false;

    // Check for ! prefix
    if (this.peek().kind === TokenKind.Word && this.peek().value === '!') {
      negated = true;
      this.advance();
    }

    const commands: CompoundCommandNode[] = [];
    commands.push(this.parseCommand());

    while (this.peek().kind === TokenKind.Pipe) {
      this.advance();
      this.skipNewlines();
      commands.push(this.parseCommand());
    }

    return { type: 'pipeline', commands, negated };
  }

  private parseCommand(): CompoundCommandNode {
    const token = this.peek();

    // Check for compound command keywords
    if (token.kind === TokenKind.Word) {
      switch (token.value) {
        case 'if': return this.parseIf();
        case 'for': return this.parseFor();
        case 'while': return this.parseWhile();
        case 'until': return this.parseUntil();
        case 'case': return this.parseCase();
      }

      // Check for function definition: name () { ... }
      if (this.peekAt(1).kind === TokenKind.LParen && this.peekAt(2).kind === TokenKind.RParen) {
        const name = token.value;
        // Don't treat keywords as function names
        if (!KEYWORDS.has(name)) {
          return this.parseFunctionDef();
        }
      }
    }

    // { ... } group
    if (token.kind === TokenKind.Word && token.value === '{') {
      return this.parseGroup();
    }

    return this.parseSimpleCommand();
  }

  private parseCompoundList(terminators: string[]): ListNode[] {
    const lists: ListNode[] = [];

    this.skipSeparators();

    while (!this.isAtEnd()) {
      // Check terminators
      const t = this.peek();
      if (t.kind === TokenKind.Word && terminators.includes(t.value)) {
        break;
      }
      if (t.kind === TokenKind.EOF) break;

      lists.push(this.parseList());
      this.skipSeparators();
    }

    return lists;
  }

  private parseIf(): IfNode {
    this.expectWord('if');
    const clauses: IfNode['clauses'] = [];
    let elseBody: ListNode[] | null = null;

    // Parse first if clause
    const condition = this.parseCompoundList(['then']);
    this.expectWord('then');
    const body = this.parseCompoundList(['elif', 'else', 'fi']);
    clauses.push({ condition, body });

    // Parse elif clauses
    while (this.isWord('elif')) {
      this.advance();
      const elifCondition = this.parseCompoundList(['then']);
      this.expectWord('then');
      const elifBody = this.parseCompoundList(['elif', 'else', 'fi']);
      clauses.push({ condition: elifCondition, body: elifBody });
    }

    // Parse else clause
    if (this.isWord('else')) {
      this.advance();
      elseBody = this.parseCompoundList(['fi']);
    }

    this.expectWord('fi');

    const redirections = this.parseTrailingRedirections();

    return { type: 'if', clauses, elseBody, redirections };
  }

  private parseFor(): ForNode {
    this.expectWord('for');
    const varToken = this.expect(TokenKind.Word);
    const variable = varToken.value;

    this.skipNewlines();

    let words: WordPart[][] | null = null;

    // Optional 'in word...'
    if (this.isWord('in')) {
      this.advance();
      words = [];
      while (!this.isAtEnd()) {
        const t = this.peek();
        if (t.kind === TokenKind.Semi || t.kind === TokenKind.Newline) break;
        if (t.kind === TokenKind.Word && t.value === 'do') break;
        if (t.kind !== TokenKind.Word) break;
        this.advance();
        words.push(t.parts ?? [{ text: t.value, quoted: 'none' }]);
      }
    }

    // Consume separator before 'do'
    this.skipSeparators();

    this.expectWord('do');
    const body = this.parseCompoundList(['done']);
    this.expectWord('done');

    const redirections = this.parseTrailingRedirections();

    return { type: 'for', variable, words, body, redirections };
  }

  private parseWhile(): WhileNode {
    this.expectWord('while');
    const condition = this.parseCompoundList(['do']);
    this.expectWord('do');
    const body = this.parseCompoundList(['done']);
    this.expectWord('done');

    const redirections = this.parseTrailingRedirections();

    return { type: 'while', condition, body, redirections };
  }

  private parseUntil(): UntilNode {
    this.expectWord('until');
    const condition = this.parseCompoundList(['do']);
    this.expectWord('do');
    const body = this.parseCompoundList(['done']);
    this.expectWord('done');

    const redirections = this.parseTrailingRedirections();

    return { type: 'until', condition, body, redirections };
  }

  private parseCase(): CaseNode {
    this.expectWord('case');
    const wordToken = this.expect(TokenKind.Word);
    const word = wordToken.parts ?? [{ text: wordToken.value, quoted: 'none' }];

    this.skipNewlines();
    this.expectWord('in');
    this.skipSeparators();

    const items: CaseNode['items'] = [];

    while (!this.isAtEnd() && !this.isWord('esac')) {
      // Optional leading (
      if (this.peek().kind === TokenKind.LParen) {
        this.advance();
      }

      // Parse patterns separated by |
      const patterns: WordPart[][] = [];
      const patToken = this.expect(TokenKind.Word);
      patterns.push(patToken.parts ?? [{ text: patToken.value, quoted: 'none' }]);

      while (this.peek().kind === TokenKind.Pipe) {
        this.advance();
        const nextPat = this.expect(TokenKind.Word);
        patterns.push(nextPat.parts ?? [{ text: nextPat.value, quoted: 'none' }]);
      }

      // Expect )
      this.expect(TokenKind.RParen);

      // Parse body until ;; or esac
      const body: ListNode[] = [];
      this.skipNewlines();

      while (!this.isAtEnd()) {
        const t = this.peek();
        if (t.kind === TokenKind.DoubleSemi) break;
        if (t.kind === TokenKind.Word && t.value === 'esac') break;
        if (t.kind === TokenKind.EOF) break;
        body.push(this.parseList());
        this.skipSeparators();
      }

      items.push({ patterns, body });

      // Consume ;;
      if (this.peek().kind === TokenKind.DoubleSemi) {
        this.advance();
        this.skipSeparators();
      }
    }

    this.expectWord('esac');

    const redirections = this.parseTrailingRedirections();

    return { type: 'case', word, items, redirections };
  }

  private parseFunctionDef(): FunctionDefNode {
    const nameToken = this.advance(); // consume name
    const name = nameToken.value;
    this.expect(TokenKind.LParen);
    this.expect(TokenKind.RParen);
    this.skipNewlines();

    const body = this.parseCommand();

    return { type: 'function_def', name, body };
  }

  private parseGroup(): GroupNode {
    this.expectWord('{');
    const body = this.parseCompoundList(['}']);
    this.expectWord('}');

    const redirections = this.parseTrailingRedirections();

    return { type: 'group', body, redirections };
  }

  private parseTrailingRedirections(): RedirectionNode[] {
    const redirections: RedirectionNode[] = [];
    while (this.isRedirectOperator(this.peek().kind)) {
      const dup = this.peek().kind === TokenKind.RedirectDup;
      const operator = this.advance().value as RedirectionNode['operator'];
      if (dup) {
        redirections.push({ operator, target: [] });
        continue;
      }
      const targetToken = this.expect(TokenKind.Word);
      redirections.push({
        operator,
        target: targetToken.parts ?? [{ text: targetToken.value, quoted: 'none' }],
      });
    }
    return redirections;
  }

  private parseSimpleCommand(): SimpleCommandNode {
    const assignments: SimpleCommandNode['assignments'] = [];
    const words: WordPart[][] = [];
    const redirections: RedirectionNode[] = [];

    while (!this.isAtEnd()) {
      const token = this.peek();

      // Check for redirections
      if (this.isRedirectOperator(token.kind)) {
        const dup = token.kind === TokenKind.RedirectDup;
        const operator = this.advance().value as RedirectionNode['operator'];
        if (dup) {
          redirections.push({ operator, target: [] });
          continue;
        }
        const targetToken = this.expect(TokenKind.Word);
        redirections.push({
          operator,
          target: targetToken.parts ?? [{ text: targetToken.value, quoted: 'none' }],
        });
        continue;
      }

      // Check for word tokens
      if (token.kind === TokenKind.Word) {
        // Don't consume keywords that are terminators in compound commands
        // (only when no words have been accumulated yet -- empty command)
        // This check is not needed here since parseCommand dispatches before us

        // Check for VAR=value assignment (only before any regular words)
        if (words.length === 0) {
          const eqIdx = token.value.indexOf('=');
          if (eqIdx > 0 && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(token.value.slice(0, eqIdx))) {
            this.advance();
            const name = token.value.slice(0, eqIdx);
            const valText = token.value.slice(eqIdx + 1);
            // Build value parts from the assignment
            const valueParts: WordPart[] = [];
            if (token.parts) {
              // Reconstruct parts after the =
              let consumed = 0;
              for (const part of token.parts) {
                const partEnd = consumed + part.text.length;
                if (partEnd <= eqIdx + 1) {
                  consumed = partEnd;
                  continue;
                }
                if (consumed < eqIdx + 1) {
                  // Part spans the =
                  valueParts.push({ text: part.text.slice(eqIdx + 1 - consumed), quoted: part.quoted });
                } else {
                  valueParts.push(part);
                }
                consumed = partEnd;
              }
            }
            if (valueParts.length === 0) {
              valueParts.push({ text: valText, quoted: 'none' });
            }
            assignments.push({ name, value: valueParts });
            continue;
          }
        }

        this.advance();
        const parts = token.parts ?? [{ text: token.value, quoted: 'none' }];
        words.push(parts);
        continue;
      }

      // Anything else (operator) ends this command
      break;
    }

    return { type: 'simple_command', assignments, words, redirections };
  }

  private isRedirectOperator(kind: TokenKind): boolean {
    return kind === TokenKind.RedirectOut
      || kind === TokenKind.RedirectAppend
      || kind === TokenKind.RedirectIn
      || kind === TokenKind.RedirectErr
      || kind === TokenKind.RedirectErrAppend
      || kind === TokenKind.RedirectAll
      || kind === TokenKind.RedirectDup;
  }
}
