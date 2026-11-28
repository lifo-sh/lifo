/**
 * Node's querystring. Arrays stringify as repeated keys and parse back into arrays (Next.js
 * passes webpack loader options this way: `pageExtensions=tsx&pageExtensions=ts`), parse
 * returns a null-prototype object, `+` is a space, and malformed escapes decode leniently.
 */

type Primitive = string | number | bigint | boolean | null | undefined;

const toText = (v: unknown): string => {
	if (typeof v === 'string') return v;
	if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
	if (typeof v === 'bigint' || typeof v === 'boolean') return String(v);
	return '';
};

export function escape(str: string): string {
	return encodeURIComponent(str);
}

/** %XX escapes as bytes (left as they are when malformed), then UTF-8. */
export function unescapeBuffer(s: string, decodeSpaces = false): Uint8Array {
	const bytes: number[] = [];
	const encoder = new TextEncoder();
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c === '%' && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))) {
			bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
			i += 2;
		} else if (c === '+' && decodeSpaces) {
			bytes.push(0x20);
		} else {
			const cp = s.codePointAt(i)!;
			const ch = String.fromCodePoint(cp);
			bytes.push(...encoder.encode(ch));
			i += ch.length - 1;
		}
	}
	return new Uint8Array(bytes);
}

export function unescape(s: string, decodeSpaces = false): string {
	try {
		return decodeURIComponent(s);
	} catch {
		return new TextDecoder().decode(unescapeBuffer(s, decodeSpaces));
	}
}

export function stringify(
	obj: Record<string, Primitive | readonly Primitive[]> | null | undefined,
	sep = '&',
	eq = '=',
	options?: { encodeURIComponent?: (s: string) => string },
): string {
	if (obj === null || typeof obj !== 'object') return '';
	const encode = options?.encodeURIComponent ?? escape;
	const parts: string[] = [];
	for (const key of Object.keys(obj)) {
		const value = obj[key];
		const k = encode(toText(key)) + eq;
		if (Array.isArray(value)) {
			for (const item of value) parts.push(k + encode(toText(item)));
		} else {
			parts.push(k + encode(toText(value)));
		}
	}
	return parts.join(sep);
}

export function parse(
	str: string,
	sep = '&',
	eq = '=',
	options?: { maxKeys?: number; decodeURIComponent?: (s: string) => string },
): Record<string, string | string[]> {
	const result: Record<string, string | string[]> = Object.create(null);
	if (typeof str !== 'string' || str.length === 0) return result;
	const decode = options?.decodeURIComponent ?? unescape;
	const maxKeys = options?.maxKeys ?? 1000;
	let pairs = str.split(sep || '&');
	if (maxKeys > 0) pairs = pairs.slice(0, maxKeys);
	const separator = eq || '=';
	for (const pair of pairs) {
		if (pair.length === 0) continue;
		const at = pair.indexOf(separator);
		const rawKey = at >= 0 ? pair.slice(0, at) : pair;
		const rawValue = at >= 0 ? pair.slice(at + separator.length) : '';
		const key = decode(rawKey.replace(/\+/g, ' '));
		const value = decode(rawValue.replace(/\+/g, ' '));
		const existing = result[key];
		if (existing === undefined) result[key] = value;
		else if (Array.isArray(existing)) existing.push(value);
		else result[key] = [existing, value];
	}
	return result;
}

export const decode = parse;
export const encode = stringify;

export default { parse, stringify, escape, unescape, unescapeBuffer, decode, encode };
