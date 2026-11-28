/**
 * TypeScript and JSX files for `node` (and `bun`, which runs on it) in a box.
 *
 * Node 22.18+ runs `.ts` files by stripping their types, and Bun runs `.ts`, `.tsx` and `.jsx`.
 * A box does the same with Sucrase: types come out (enums and other TypeScript-only syntax are
 * compiled), JSX becomes calls to the project's JSX runtime, and everything else, `import`s
 * included, stays as written for the box's own ES module handling.
 *
 * Sucrase is synchronous, which the box's `require` needs, but it loads on demand: `node` calls
 * loadTypeScript() before it runs an entry file with one of these extensions, so a run that
 * never touches TypeScript never downloads it.
 */

type Sucrase = typeof import('sucrase');
type Transform = 'typescript' | 'jsx';

let sucrase: Sucrase | null = null;
let loading: Promise<boolean> | null = null;

const TS_FILE = /\.(?:[mc]?ts|tsx)$/;
const RUNNABLE = /\.(?:[mc]?ts|tsx|jsx)$/;

/** A file `node` has to transform before it runs: TypeScript (not a `.d.ts`) or JSX. */
export function needsTypeScript(filename: string): boolean {
	return RUNNABLE.test(filename) && !/\.d\.[mc]?ts$/.test(filename);
}

/** Load Sucrase once per realm. False when it can't be loaded (offline, no bundle). */
export function loadTypeScript(): Promise<boolean> {
	if (sucrase) return Promise.resolve(true);
	loading ??= import('sucrase').then(
		(m) => { sucrase = (m as { default?: Sucrase }).default ?? m; return true; },
		() => { loading = null; return false; },
	);
	return loading;
}

export function typeScriptLoaded(): boolean {
	return sucrase !== null;
}

/** What a project's tsconfig.json says about JSX, which decides the runtime JSX compiles to. */
export interface JsxOptions {
	/** Classic `React.createElement` calls (tsconfig `"jsx": "react"`) instead of the automatic runtime. */
	classic?: boolean;
	/** The automatic runtime's package (tsconfig `jsxImportSource`, default `react`). */
	importSource?: string;
	pragma?: string;
	pragmaFrag?: string;
}

/** Strip TypeScript types from a file and compile its JSX. Call loadTypeScript() first. */
export function stripTypes(source: string, filename: string, jsx: JsxOptions = {}): string {
	if (!sucrase) {
		const ext = filename.slice(filename.lastIndexOf('.'));
		throw Object.assign(new TypeError(`Unknown file extension "${ext}" for ${filename} (in a box, TypeScript runs when the entry file is TypeScript: node main.ts)`), {
			code: 'ERR_UNKNOWN_FILE_EXTENSION',
		});
	}
	const transforms: Transform[] = [];
	if (TS_FILE.test(filename)) transforms.push('typescript');
	if (/\.[jt]sx$/.test(filename)) transforms.push('jsx');
	return sucrase.transform(source, {
		transforms,
		filePath: filename,
		disableESTransforms: true,
		jsxRuntime: jsx.classic ? 'classic' : 'automatic',
		production: true,
		...(jsx.importSource ? { jsxImportSource: jsx.importSource } : {}),
		...(jsx.pragma ? { jsxPragma: jsx.pragma } : {}),
		...(jsx.pragmaFrag ? { jsxFragmentPragma: jsx.pragmaFrag } : {}),
	}).code;
}

/** Read the JSX settings from tsconfig.json's compilerOptions (comments and trailing commas allowed). */
export function jsxOptionsFromTsconfig(text: string): JsxOptions {
	let config: { compilerOptions?: Record<string, unknown> };
	try {
		config = JSON.parse(stripJsonComments(text));
	} catch {
		return {};
	}
	const o = config.compilerOptions ?? {};
	const out: JsxOptions = {};
	if (o.jsx === 'react') out.classic = true;
	if (typeof o.jsxImportSource === 'string') out.importSource = o.jsxImportSource;
	if (typeof o.jsxFactory === 'string') out.pragma = o.jsxFactory;
	if (typeof o.jsxFragmentFactory === 'string') out.pragmaFrag = o.jsxFragmentFactory;
	return out;
}

/** JSONC → JSON: drop // and block comments outside strings, and trailing commas. */
export function stripJsonComments(text: string): string {
	let out = '';
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === '"') {
			const start = i;
			for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
			out += text.slice(start, i + 1);
		} else if (c === '/' && text[i + 1] === '/') {
			while (i < text.length && text[i] !== '\n') i++;
			out += '\n';
		} else if (c === '/' && text[i + 1] === '*') {
			const end = text.indexOf('*/', i + 2);
			i = end === -1 ? text.length : end + 1;
		} else if (c === ',' && /^\s*(?:\/\/[^\n]*\s*|\/\*[\s\S]*?\*\/\s*)*[}\]]/.test(text.slice(i + 1))) {
			// A trailing comma (comments may sit between it and the bracket): drop it.
		} else {
			out += c;
		}
	}
	return out;
}
