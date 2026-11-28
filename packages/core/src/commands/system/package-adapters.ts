/**
 * Small adjustments to a few npm packages' code as a box loads it, where a package depends on
 * something a box can't have and there's a faithful equivalent. Each adapter matches one file
 * and changes nothing when the code it expects isn't there (another version of the package).
 */

interface PackageAdapter {
	/** Matches the module's absolute filename. */
	file: RegExp;
	adapt(source: string): string;
}

/**
 * Next.js: a box runs `next dev` and `next build` with webpack, because Turbopack is native only.
 * Projects configured for Turbopack keep their loaders in `turbopack.rules` (create-next-app
 * puts Tailwind there: `'*.css': { loaders: ['@tailwindcss/turbopack'] }`), which webpack never
 * reads. Turbopack's rule loaders are webpack loaders, so the rules that keep a file's type
 * carry over as webpack pre-loaders on the client compiler (the one that emits CSS and client
 * code). Rules with conditions, or that turn a file into another type (`as: '*.js'`), are left
 * out: Next's own webpack rules already handle those files differently.
 */
const NEXT_TURBOPACK_RULES = String.raw`
;async function getBaseWebpackConfig(dir, opts) {
	const webpackConfig = await __lifoBaseWebpackConfig(dir, opts);
	try {
		__lifoTurbopackRules(webpackConfig, opts, dir);
	} catch (err) {
		console.warn('[lifo] turbopack.rules were not applied to webpack: ' + (err && err.message));
	}
	return webpackConfig;
}
function __lifoGlobRegExp(glob) {
	let s = glob.replace(/^\.\//, '').replace(/[.+^$()|[\]\\]/g, '\\$&');
	s = s.replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0002').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
	s = s.replace(/\{([^{}]*)\}/g, (_, alts) => '(?:' + alts.split(',').join('|') + ')');
	s = s.replace(/\u0001/g, '(?:.*/)?').replace(/\u0002/g, '.*');
	return new RegExp('^' + s + '$');
}
function __lifoTurbopackRules(webpackConfig, opts, dir) {
	const rules = opts && opts.config && opts.config.turbopack && opts.config.turbopack.rules;
	if (!rules || typeof rules !== 'object' || opts.compilerType !== 'client') return;
	if (!webpackConfig.module) webpackConfig.module = {};
	if (!Array.isArray(webpackConfig.module.rules)) webpackConfig.module.rules = [];
	const path = require('path');
	const isLoader = (l) => typeof l === 'string' || (!!l && typeof l === 'object' && typeof l.loader === 'string');
	for (const glob of Object.keys(rules)) {
		const value = rules[glob];
		const list = Array.isArray(value) && value.every(isLoader) ? [{ loaders: value }] : Array.isArray(value) ? value : [value];
		const ext = (glob.match(/\.[^./*{}]+$/) || [''])[0];
		const byPath = glob.includes('/');
		const re = __lifoGlobRegExp(glob);
		for (const rule of list) {
			if (!rule || typeof rule !== 'object' || rule.condition) continue;
			const loaders = rule.loaders;
			if (!Array.isArray(loaders) || loaders.length === 0 || !loaders.every(isLoader)) continue;
			if (rule.as && (!ext || !String(rule.as).endsWith(ext))) continue;
			webpackConfig.module.rules.push({
				enforce: 'pre',
				test: (file) => re.test(byPath ? path.relative(dir, file).split(path.sep).join('/') : path.basename(file)),
				use: loaders.map((l) => (typeof l === 'string' ? { loader: l } : l)),
			});
		}
	}
}
`;

const ADAPTERS: PackageAdapter[] = [
	{
		file: /\/node_modules\/next\/dist\/build\/webpack-config\.js$/,
		adapt(source) {
			const declaration = /\basync function getBaseWebpackConfig\(/;
			if (!declaration.test(source)) return source;
			return source.replace(declaration, 'async function __lifoBaseWebpackConfig(') + NEXT_TURBOPACK_RULES;
		},
	},
];

/** The module's source with any adapter for its file applied. */
export function adaptPackageSource(filename: string, source: string): string {
	for (const adapter of ADAPTERS) {
		if (adapter.file.test(filename)) return adapter.adapt(source);
	}
	return source;
}
