/**
 * node:string_decoder shim.
 *
 * Implemented as a classic function constructor (NOT an ES class) on purpose:
 * legacy libraries inherit from it via `StringDecoder.call(this, enc)` (e.g.
 * iconv-lite's InternalDecoder, reached through raw-body → body-parser →
 * express.json). Invoking an ES class without `new` throws "Class constructor
 * cannot be invoked without 'new'", which broke POST body parsing in Express.
 * This form works with `new StringDecoder(enc)`, `StringDecoder(enc)`, and
 * `StringDecoder.call(obj, enc)`.
 */
interface SD {
  decoder: TextDecoder;
  encoding: string;
  write(buffer: Uint8Array): string;
  end(buffer?: Uint8Array): string;
}

const ENC_MAP: Record<string, string> = {
  utf8: 'utf-8',
  utf16le: 'utf-16le',
  ucs2: 'utf-16le',
  latin1: 'latin1',
  binary: 'latin1',
  ascii: 'ascii',
};

export function StringDecoder(this: unknown, encoding?: string): SD {
  // `new StringDecoder()` / `StringDecoder.call(obj)` → use `this`; bare call → fresh object.
  const self = (this && this !== globalThis ? this : Object.create(StringDecoder.prototype)) as SD;
  const norm = (encoding || 'utf8').toLowerCase().replace(/[-_]/g, '');
  self.encoding = encoding || 'utf8';
  self.decoder = new TextDecoder(ENC_MAP[norm] || 'utf-8');
  return self;
}

(StringDecoder.prototype as SD).write = function (this: SD, buffer: Uint8Array): string {
  return this.decoder.decode(buffer, { stream: true });
};

(StringDecoder.prototype as SD).end = function (this: SD, buffer?: Uint8Array): string {
  return buffer ? this.decoder.decode(buffer) : this.decoder.decode();
};

export default { StringDecoder };
