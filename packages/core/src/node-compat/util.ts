export function format(fmt: string, ...args: unknown[]): string {
  if (typeof fmt !== 'string') {
    return [fmt, ...args].map((a) => inspect(a)).join(' ');
  }

  let i = 0;
  let result = fmt.replace(/%([sdjoO%])/g, (match, type) => {
    if (type === '%') return '%';
    if (i >= args.length) return match;
    const arg = args[i++];
    switch (type) {
      case 's': return String(arg);
      case 'd': return String(Number(arg));
      case 'j':
        try { return JSON.stringify(arg); }
        catch { return '[Circular]'; }
      case 'o': case 'O': return inspect(arg);
      default: return match;
    }
  });

  // Append remaining args
  while (i < args.length) {
    result += ' ' + inspect(args[i++]);
  }

  return result;
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

export function promisify<T>(fn: (...args: [...unknown[], (err: unknown, result: T) => void]) => void): (...args: unknown[]) => Promise<T> {
  return (...args: unknown[]) => new Promise<T>((resolve, reject) => {
    fn(...args, (err: unknown, result: T) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
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

export function types() {
  return {
    isDate: (v: unknown) => v instanceof Date,
    isRegExp: (v: unknown) => v instanceof RegExp,
    isArray: Array.isArray,
  };
}

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

export const TextDecoder = globalThis.TextDecoder;
export const TextEncoder = globalThis.TextEncoder;

export default { format, inspect, promisify, inherits, deprecate, types, styleText, stripVTControlCharacters, TextDecoder, TextEncoder };
