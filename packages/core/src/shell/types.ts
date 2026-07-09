// ─── Token types ───

export enum TokenKind {
  Word,
  Pipe,           // |
  And,            // &&
  Or,             // ||
  Semi,           // ;
  Amp,            // &
  RedirectOut,    // >
  RedirectAppend, // >>
  RedirectIn,     // <
  RedirectErr,    // 2>
  RedirectErrAppend, // 2>>
  RedirectAll,    // &>
  RedirectDup,    // 2>&1 / >&2 / >&1 — stream duplication, takes no target word
  DoubleSemi,     // ;;
  LParen,         // (
  RParen,         // )
  Newline,        // \n
  EOF,
}

export interface WordPart {
  text: string;
  quoted: 'none' | 'single' | 'double';
}

export interface Token {
  kind: TokenKind;
  value: string;
  pos: number;
  parts?: WordPart[];  // only for Word tokens
}

// ─── AST node types ───

export interface ScriptNode {
  type: 'script';
  lists: ListNode[];
}

export interface ListNode {
  type: 'list';
  entries: Array<{
    pipeline: PipelineNode;
    connector: '&&' | '||' | null;
  }>;
  background: boolean;
}

export interface PipelineNode {
  type: 'pipeline';
  commands: CompoundCommandNode[];
  negated: boolean;
}

export interface SimpleCommandNode {
  type: 'simple_command';
  assignments: Array<{ name: string; value: WordPart[] }>;
  words: WordPart[][];          // each element = one arg (array of parts)
  redirections: RedirectionNode[];
}

export interface RedirectionNode {
  operator: '>' | '>>' | '<' | '2>' | '2>>' | '&>' | '2>&1' | '>&2' | '>&1';
  /** Empty for dup operators (2>&1 / >&2 / >&1) — they duplicate an existing
   *  stream rather than open a file. */
  target: WordPart[];
}

export interface IfNode {
  type: 'if';
  clauses: Array<{ condition: ListNode[]; body: ListNode[] }>;
  elseBody: ListNode[] | null;
  redirections: RedirectionNode[];
}

export interface ForNode {
  type: 'for';
  variable: string;
  words: WordPart[][] | null;  // null = use "$@"
  body: ListNode[];
  redirections: RedirectionNode[];
}

export interface WhileNode {
  type: 'while';
  condition: ListNode[];
  body: ListNode[];
  redirections: RedirectionNode[];
}

export interface UntilNode {
  type: 'until';
  condition: ListNode[];
  body: ListNode[];
  redirections: RedirectionNode[];
}

export interface CaseNode {
  type: 'case';
  word: WordPart[];
  items: Array<{ patterns: WordPart[][]; body: ListNode[] }>;
  redirections: RedirectionNode[];
}

export interface FunctionDefNode {
  type: 'function_def';
  name: string;
  body: CompoundCommandNode;
}

export interface GroupNode {
  type: 'group';
  body: ListNode[];
  redirections: RedirectionNode[];
}

export type CompoundCommandNode =
  | SimpleCommandNode
  | IfNode
  | ForNode
  | WhileNode
  | UntilNode
  | CaseNode
  | GroupNode
  | FunctionDefNode;

export type ASTNode = ScriptNode | ListNode | PipelineNode | CompoundCommandNode;
