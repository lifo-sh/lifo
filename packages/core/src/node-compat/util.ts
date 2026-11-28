/** Node's util.format: top-level strings print as-is; everything else is inspected. */
const formatArg = (a: unknown): string => (typeof a === 'string' ? a : inspect(a));

export function format(fmt: string, ...args: unknown[]): string {
  if (typeof fmt !== 'string') {
    return [fmt, ...args].map(formatArg).join(' ');
  }

  let i = 0;
  let result = fmt.replace(/%([sdifjoOc%])/g, (match, type) => {
    if (type === '%') return '%';
    if (i >= args.length) return match;
    const arg = args[i++];
    switch (type) {
      case 's':
        return typeof arg === 'object' && arg !== null && !(arg instanceof Error) && (arg as object).toString === Object.prototype.toString
          ? inspect(arg, { depth: 1 })
          : String(arg);
      case 'd': return typeof arg === 'bigint' ? `${arg}n` : String(Number(arg));
      case 'i': return String(parseInt(String(arg), 10));
      case 'f': return String(parseFloat(String(arg)));
      case 'j':
        try { return JSON.stringify(arg); }
        catch { return '[Circular]'; }
      case 'o': case 'O': return inspect(arg);
      case 'c': return ''; // CSS styling: ignored, as in Node
      default: return match;
    }
  });

  // Append remaining args
  while (i < args.length) {
    result += ' ' + formatArg(args[i++]);
  }

  return result;
}

/**
 * Like `format`, but the first argument is an inspect-options object (Node's
 * `util.formatWithOptions(inspectOptions, format, ...args)`). We don't thread
 * the options into inspect (colors/depth are cosmetic), so just delegate — the
 * `debug` package relies on this existing.
 */
export function formatWithOptions(_inspectOptions: unknown, fmt: string, ...args: unknown[]): string {
  return format(fmt, ...args);
}

export function inspect(obj: unknown, opts?: { depth?: number; colors?: boolean }): string {
  const depth = opts?.depth ?? 2;
  return formatValue(obj, depth);
}

function formatValue(value: unknown, depth: number): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';

  const type = typeof value;
  if (type === 'string') return `'${value}'`;
  if (type === 'number' || type === 'boolean' || type === 'bigint') return String(value);
  if (type === 'symbol') return value.toString();
  if (type === 'function') return `[Function: ${(value as { name: string }).name || 'anonymous'}]`;

  if (value instanceof Date) return value.toISOString();
  if (value instanceof RegExp) return value.toString();
  if (value instanceof Error) return `${value.name}: ${value.message}`;

  if (Array.isArray(value)) {
    if (depth < 0) return '[Array]';
    const items = value.map((v) => formatValue(v, depth - 1));
    return `[ ${items.join(', ')} ]`;
  }

  if (value instanceof Uint8Array) {
    return `<Buffer ${Array.from(value.slice(0, 50)).map((b) => b.toString(16).padStart(2, '0')).join(' ')}${value.length > 50 ? ' ...' : ''}>`;
  }

  if (typeof value === 'object') {
    if (depth < 0) return '[Object]';
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    const pairs = entries.map(([k, v]) => `${k}: ${formatValue(v, depth - 1)}`);
    return `{ ${pairs.join(', ')} }`;
  }

  return String(value);
}

const PROMISIFY_CUSTOM = Symbol.for('nodejs.util.promisify.custom');

/** Node's: a function's own promise form (`fn[util.promisify.custom]`) when it has one. */
export function promisify<T>(fn: (...args: [...unknown[], (err: unknown, result: T) => void]) => void): (...args: unknown[]) => Promise<T> {
  // A function a box lacks (undefined) still gives a promise function, failing only if called.
  const custom = fn == null ? undefined : (fn as unknown as Record<symbol, unknown>)[PROMISIFY_CUSTOM];
  if (typeof custom === 'function') return custom as (...args: unknown[]) => Promise<T>;
  return (...args: unknown[]) => new Promise<T>((resolve, reject) => {
    fn(...args, (err: unknown, result: T) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}
promisify.custom = PROMISIFY_CUSTOM;

/** Node's util.aborted(signal, resource): a promise that settles when the signal aborts. */
export function aborted(signal: AbortSignal, _resource: unknown): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/**
 * Node's: an async function as one that takes a callback last. The callback runs on a later
 * tick; a falsy rejection reason becomes an Error carrying it as `reason`, as in Node.
 */
export function callbackify(original: (...args: unknown[]) => Promise<unknown>): (...args: unknown[]) => void {
  if (typeof original !== 'function') {
    throw Object.assign(new TypeError('The "original" argument must be of type function'), { code: 'ERR_INVALID_ARG_TYPE' });
  }
  return function (this: unknown, ...args: unknown[]) {
    const callback = args.pop();
    if (typeof callback !== 'function') {
      throw Object.assign(new TypeError('The last argument must be of type function'), { code: 'ERR_INVALID_ARG_TYPE' });
    }
    const later = (fn: () => void) => queueMicrotask(fn);
    Promise.resolve(original.apply(this, args)).then(
      (value) => later(() => callback(null, value)),
      (reason) => {
        const err = reason ? reason : Object.assign(new Error('Promise was rejected with a falsy value'), { code: 'ERR_FALSY_VALUE_REJECTION', reason });
        later(() => callback(err));
      },
    );
  };
}

export function inherits(ctor: { prototype: object; super_?: unknown }, superCtor: { prototype: object } | null | undefined): void {
  if (superCtor === undefined || superCtor === null) {
    throw new TypeError('The super constructor to "inherits" must not be null or undefined');
  }
  if (typeof superCtor.prototype === 'undefined') {
    throw new TypeError('The super constructor to "inherits" must have a prototype');
  }
  ctor.super_ = superCtor;
  Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
}

export function deprecate<T extends (...args: unknown[]) => unknown>(fn: T, msg: string): T {
  let warned = false;
  return ((...args: unknown[]) => {
    if (!warned) {
      console.warn(`DeprecationWarning: ${msg}`);
      warned = true;
    }
    return fn(...args);
  }) as unknown as T;
}

const SharedAB = (globalThis as { SharedArrayBuffer?: unknown }).SharedArrayBuffer as
  | (new () => object)
  | undefined;

/** util.types — runtime type predicates (Node's `require('util/types')`). */
export const typesImpl = {
  isAnyArrayBuffer: (v: unknown) => v instanceof ArrayBuffer || (!!SharedAB && v instanceof (SharedAB as never)),
  isArrayBuffer: (v: unknown) => v instanceof ArrayBuffer,
  isSharedArrayBuffer: (v: unknown) => !!SharedAB && v instanceof (SharedAB as never),
  isArrayBufferView: (v: unknown) => ArrayBuffer.isView(v),
  isTypedArray: (v: unknown) => ArrayBuffer.isView(v) && !(v instanceof DataView),
  isDataView: (v: unknown) => v instanceof DataView,
  isUint8Array: (v: unknown) => v instanceof Uint8Array,
  isUint8ClampedArray: (v: unknown) => v instanceof Uint8ClampedArray,
  isUint16Array: (v: unknown) => v instanceof Uint16Array,
  isUint32Array: (v: unknown) => v instanceof Uint32Array,
  isInt8Array: (v: unknown) => v instanceof Int8Array,
  isInt16Array: (v: unknown) => v instanceof Int16Array,
  isInt32Array: (v: unknown) => v instanceof Int32Array,
  isFloat32Array: (v: unknown) => v instanceof Float32Array,
  isFloat64Array: (v: unknown) => v instanceof Float64Array,
  isBigInt64Array: (v: unknown) => typeof BigInt64Array !== 'undefined' && v instanceof BigInt64Array,
  isBigUint64Array: (v: unknown) => typeof BigUint64Array !== 'undefined' && v instanceof BigUint64Array,
  isDate: (v: unknown) => v instanceof Date,
  isRegExp: (v: unknown) => v instanceof RegExp,
  isMap: (v: unknown) => v instanceof Map,
  isSet: (v: unknown) => v instanceof Set,
  isWeakMap: (v: unknown) => v instanceof WeakMap,
  isWeakSet: (v: unknown) => v instanceof WeakSet,
  isPromise: (v: unknown) => v instanceof Promise,
  isNativeError: (v: unknown) => v instanceof Error,
  isAsyncFunction: (v: unknown) => typeof v === 'function' && (v as { constructor?: { name?: string } }).constructor?.name === 'AsyncFunction',
  isGeneratorFunction: (v: unknown) => typeof v === 'function' && (v as { constructor?: { name?: string } }).constructor?.name === 'GeneratorFunction',
  isGeneratorObject: (v: unknown) => !!v && typeof (v as { next?: unknown }).next === 'function' && typeof (v as { throw?: unknown }).throw === 'function',
  isArgumentsObject: (v: unknown) => Object.prototype.toString.call(v) === '[object Arguments]',
  isBoxedPrimitive: (v: unknown) => v instanceof Number || v instanceof String || v instanceof Boolean || v instanceof Symbol,
  isProxy: () => false,
  isModuleNamespaceObject: (v: unknown) => Object.prototype.toString.call(v) === '[object Module]',
  isArray: Array.isArray,
};

// In Node, `util.types` is a namespace object, not a function.
export const types = typesImpl;

/** Strip ANSI/VT control sequences from a string (ESC[...m, etc.) */
const STYLE_CODES: Record<string, [number, number]> = {
	reset: [0, 0], bold: [1, 22], dim: [2, 22], italic: [3, 23], underline: [4, 24],
	blink: [5, 25], inverse: [7, 27], hidden: [8, 28], strikethrough: [9, 29],
	doubleunderline: [21, 24], framed: [51, 54], overlined: [53, 55],
	black: [30, 39], red: [31, 39], green: [32, 39], yellow: [33, 39], blue: [34, 39],
	magenta: [35, 39], cyan: [36, 39], white: [37, 39], gray: [90, 39], grey: [90, 39],
	blackBright: [90, 39], redBright: [91, 39], greenBright: [92, 39], yellowBright: [93, 39],
	blueBright: [94, 39], magentaBright: [95, 39], cyanBright: [96, 39], whiteBright: [97, 39],
	bgBlack: [40, 49], bgRed: [41, 49], bgGreen: [42, 49], bgYellow: [43, 49], bgBlue: [44, 49],
	bgMagenta: [45, 49], bgCyan: [46, 49], bgWhite: [47, 49], bgGray: [100, 49], bgGrey: [100, 49],
	bgBlackBright: [100, 49], bgRedBright: [101, 49], bgGreenBright: [102, 49],
	bgYellowBright: [103, 49], bgBlueBright: [104, 49], bgMagentaBright: [105, 49],
	bgCyanBright: [106, 49], bgWhiteBright: [107, 49],
};

/** Node 20+ util.styleText(format, text) — ANSI-styled terminal text. */
export function styleText(format: string | string[], text: string): string {
	const formats = Array.isArray(format) ? format : [format];
	let open = '';
	let close = '';
	for (const f of formats) {
		const codes = STYLE_CODES[f];
		if (!codes) throw new TypeError(`The value "${f}" is invalid for argument "format"`);
		open += `\u001b[${codes[0]}m`;
		close = `\u001b[${codes[1]}m` + close;
	}
	return open + text + close;
}

export function stripVTControlCharacters(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]|\x1B\].*?(?:\x07|\x1B\\)/g, '');
}

/**
 * util.debuglog(section[, callback]) → a logger function that is active only
 * when NODE_DEBUG matches the section. undici and others call this at load
 * time and expect a callable with an `.enabled` flag.
 */
export function debuglog(section: string, callback?: (fn: DebugLogger) => void): DebugLogger {
  const nodeDebug = (typeof process !== 'undefined' && process.env && process.env.NODE_DEBUG) || '';
  const enabled = nodeDebug
    .split(/[\s,]+/)
    .some((s) => s === section || (s.endsWith('*') && section.startsWith(s.slice(0, -1))));
  const logger = ((...args: unknown[]) => {
    if (enabled) console.error(`${section} ${format(...(args as [string, ...unknown[]]))}`);
  }) as DebugLogger;
  logger.enabled = enabled;
  if (callback) callback(logger);
  return logger;
}
interface DebugLogger { (...args: unknown[]): void; enabled: boolean; }

export const debug = debuglog;

/**
 * Structural deep equality with Node's semantics: `strict` compares primitives with ===
 * (NaN equals NaN) and requires matching prototypes, as assert.deepStrictEqual does.
 */
export function deepEqual(a: unknown, b: unknown, strict: boolean, seen: WeakMap<object, unknown> = new WeakMap()): boolean {
  if (a === b) return true;
  // NaN
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    // primitives / mixed
    return strict ? a === b : a == b; // eslint-disable-line eqeqeq
  }
  const oa = a as Record<string, unknown> & object;
  const ob = b as Record<string, unknown> & object;
  if (strict && Object.getPrototypeOf(oa) !== Object.getPrototypeOf(ob)) return false;
  // cycle guard
  const prev = seen.get(oa);
  if (prev === ob) return true;
  seen.set(oa, ob);
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (a instanceof RegExp || b instanceof RegExp) {
    return a instanceof RegExp && b instanceof RegExp && a.source === b.source && a.flags === b.flags;
  }
  const aArr = Array.isArray(a), bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr && bArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i], strict, seen)) return false;
    return true;
  }
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map && b instanceof Map) || a.size !== b.size) return false;
    for (const [k, v] of a) { if (!b.has(k) || !deepEqual(v, b.get(k), strict, seen)) return false; }
    return true;
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set && b instanceof Set) || a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
  }
  const ka = Object.keys(oa), kb = Object.keys(ob);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(ob, k)) return false;
    if (!deepEqual(oa[k], ob[k], strict, seen)) return false;
  }
  return true;
}

/** util.isDeepStrictEqual (Vite 8 compares resolved configs with it). */
export function isDeepStrictEqual(a: unknown, b: unknown): boolean {
  return deepEqual(a, b, true);
}

// ─── parseArgs (Node 18.3+) ───
// Node's command-line parser: long and short options, inline values (`--a=1`, `-a1`), short
// groups (`-abc`), `--`, `--no-x` with allowNegative, defaults, `multiple`, tokens, and the
// strict-mode errors. Next.js reads NODE_OPTIONS with it.

interface ParseArgsOptionConfig { type: 'string' | 'boolean'; short?: string; multiple?: boolean; default?: unknown }
interface ParseArgsConfig {
  args?: string[];
  options?: Record<string, ParseArgsOptionConfig>;
  strict?: boolean;
  allowPositionals?: boolean;
  allowNegative?: boolean;
  tokens?: boolean;
}
type ParseArgsToken =
  | { kind: 'option'; name: string; rawName: string; index: number; value: string | undefined; inlineValue: boolean | undefined }
  | { kind: 'positional'; index: number; value: string }
  | { kind: 'option-terminator'; index: number };

function parseArgsError(code: string, message: string): TypeError {
  return Object.assign(new TypeError(message), { code });
}

export function parseArgs(config: ParseArgsConfig = {}) {
  const proc = (globalThis as { process?: { argv?: string[] } }).process;
  const args = config.args ?? (proc?.argv ?? []).slice(2);
  const options = config.options ?? {};
  const strict = config.strict ?? true;
  const allowPositionals = config.allowPositionals ?? !strict;
  const allowNegative = config.allowNegative ?? false;
  const byShort = new Map<string, string>();
  for (const [name, opt] of Object.entries(options)) if (opt.short) byShort.set(opt.short, name);

  const tokens: ParseArgsToken[] = [];
  const takesValue = (name: string) => options[name]?.type === 'string';
  const isOptionLike = (a: string | undefined) => a !== undefined && a.length > 1 && a.startsWith('-');
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      tokens.push({ kind: 'option-terminator', index: i });
      for (let j = i + 1; j < args.length; j++) tokens.push({ kind: 'positional', index: j, value: args[j] });
      break;
    }
    if (arg.startsWith('--') && arg.length > 2) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        tokens.push({ kind: 'option', name: arg.slice(2, eq), rawName: arg.slice(0, eq), index: i, value: arg.slice(eq + 1), inlineValue: true });
        continue;
      }
      const name = arg.slice(2);
      if (takesValue(name) && i + 1 < args.length) {
        tokens.push({ kind: 'option', name, rawName: arg, index: i, value: args[i + 1], inlineValue: false });
        i++;
      } else {
        tokens.push({ kind: 'option', name, rawName: arg, index: i, value: undefined, inlineValue: undefined });
      }
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1 && arg !== '-') {
      const letters = arg.slice(1);
      for (let k = 0; k < letters.length; k++) {
        const letter = letters[k];
        const name = byShort.get(letter) ?? letter;
        const rawName = `-${letter}`;
        if (takesValue(name)) {
          const rest = letters.slice(k + 1);
          if (rest) tokens.push({ kind: 'option', name, rawName, index: i, value: rest, inlineValue: true });
          else if (i + 1 < args.length) { tokens.push({ kind: 'option', name, rawName, index: i, value: args[i + 1], inlineValue: false }); i++; }
          else tokens.push({ kind: 'option', name, rawName, index: i, value: undefined, inlineValue: undefined });
          break;
        }
        tokens.push({ kind: 'option', name, rawName, index: i, value: undefined, inlineValue: undefined });
      }
      continue;
    }
    tokens.push({ kind: 'positional', index: i, value: arg });
  }

  const values: Record<string, unknown> = Object.create(null);
  const positionals: string[] = [];
  const store = (name: string, value: unknown) => {
    if (options[name]?.multiple) ((values[name] ??= []) as unknown[]).push(value);
    else values[name] = value;
  };
  for (const token of tokens) {
    if (token.kind === 'positional') {
      if (!allowPositionals) throw parseArgsError('ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL', `Unexpected argument '${token.value}'. This command does not take positional arguments`);
      positionals.push(token.value);
      continue;
    }
    if (token.kind !== 'option') continue;
    let { name } = token;
    let negated = false;
    if (allowNegative && name.startsWith('no-') && options[name.slice(3)]?.type === 'boolean') {
      name = name.slice(3);
      negated = true;
    }
    const opt = options[name];
    if (strict) {
      if (!opt) throw parseArgsError('ERR_PARSE_ARGS_UNKNOWN_OPTION', `Unknown option '${token.rawName}'`);
      if (opt.type === 'string' && (token.value === undefined || (!token.inlineValue && isOptionLike(token.value)))) {
        throw parseArgsError('ERR_PARSE_ARGS_INVALID_OPTION_VALUE', `Option '${token.rawName} <value>' argument missing`);
      }
      if (opt.type === 'boolean' && token.value !== undefined) {
        throw parseArgsError('ERR_PARSE_ARGS_INVALID_OPTION_VALUE', `Option '${token.rawName}' does not take an argument`);
      }
    }
    if (negated) store(name, false);
    else if (opt?.type === 'boolean') store(name, true);
    else store(name, token.value ?? true);
  }
  for (const [name, opt] of Object.entries(options)) {
    if (opt.default !== undefined && values[name] === undefined) values[name] = opt.default;
  }
  return config.tokens ? { values, positionals, tokens } : { values, positionals };
}

export const TextDecoder = globalThis.TextDecoder;
export const TextEncoder = globalThis.TextEncoder;

export default { format, formatWithOptions, inspect, promisify, callbackify, aborted, inherits, deprecate, types, styleText, stripVTControlCharacters, debuglog, debug, isDeepStrictEqual, parseArgs, TextDecoder, TextEncoder };
