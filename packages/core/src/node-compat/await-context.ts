/**
 * The `await` half of Lifo's async context (async-context.ts). A native `await` resumes the
 * async function without any code of ours running, so the active stores would be whatever ran
 * last. Each `await X` in a module the node runner loads becomes
 *
 *   __lifoAsync.r(__lifoAsync.s(), await X)
 *
 * Arguments evaluate left to right, so `s()` captures the frame before the function suspends
 * and `r()` restores it as the function resumes, before the awaited value is used. The rewrite
 * only inserts text on the same line, so line numbers in stack traces don't move.
 */
import { parse } from 'acorn';

const OPEN = '__lifoAsync.r(__lifoAsync.s(), ';

interface AstNode {
	type: string;
	start: number;
	end: number;
	[key: string]: unknown;
}

type Edit = { start: number; end: number; text: string };

/**
 * The edits for every AwaitExpression in the program, and for every `eval("...")` of a string
 * literal: webpack's eval-source-map builds (Next.js's dev server bundle) keep each module's
 * code in one, so its awaits are rewritten inside the string.
 */
function contextEdits(program: AstNode): Edit[] {
	const edits: Edit[] = [];
	const stack: unknown[] = [program];
	while (stack.length > 0) {
		const value = stack.pop();
		if (Array.isArray(value)) {
			for (const item of value) stack.push(item);
			continue;
		}
		if (!value || typeof value !== 'object') continue;
		const node = value as AstNode;
		if (typeof node.type !== 'string') continue;
		if (node.type === 'AwaitExpression') {
			edits.push({ start: node.start, end: node.start, text: OPEN }, { start: node.end, end: node.end, text: ')' });
		} else if (node.type === 'CallExpression') {
			const callee = node.callee as AstNode | undefined;
			const [arg] = (node.arguments as AstNode[] | undefined) ?? [];
			if (callee?.type === 'Identifier' && callee.name === 'eval' && arg?.type === 'Literal' && typeof arg.value === 'string') {
				const code = instrumentAwaits(arg.value);
				if (code !== arg.value) edits.push({ start: arg.start, end: arg.end, text: JSON.stringify(code) });
			}
		}
		for (const key in node) {
			if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
			const child = node[key];
			if (child && typeof child === 'object') stack.push(child);
		}
	}
	return edits;
}

/**
 * `source` with every `await` carrying the async context. Returned unchanged when it has no
 * `await` or doesn't parse (that module then loses the context after an await, as before).
 */
export function instrumentAwaits(source: string): string {
	if (!/\bawait\b/.test(source)) return source;
	let program: AstNode;
	try {
		program = parse(source, {
			ecmaVersion: 'latest',
			sourceType: 'script',
			allowReturnOutsideFunction: true,
			allowAwaitOutsideFunction: true,
			allowHashBang: true,
			allowImportExportEverywhere: true,
			allowSuperOutsideMethod: true,
		}) as unknown as AstNode;
	} catch {
		return source;
	}
	const edits = contextEdits(program);
	if (edits.length === 0) return source;
	// In source order; at one position a closing paren goes before anything that opens there.
	edits.sort((a, b) => a.start - b.start || (a.text === ')' ? -1 : 1) - (b.text === ')' ? -1 : 1));
	let out = '';
	let at = 0;
	for (const edit of edits) {
		out += source.slice(at, edit.start) + edit.text;
		at = edit.end;
	}
	return out + source.slice(at);
}
