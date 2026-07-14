import { describe, it, expect } from 'vitest';
import { createHttp } from '../../src/node-compat/http.js';
import { VFS } from '../../src/kernel/vfs/index.js';
import { createFs } from '../../src/node-compat/fs.js';
import { StringDecoder } from '../../src/node-compat/string_decoder.js';
import type { VirtualRequestHandler } from '../../src/kernel/index.js';

/**
 * Regression tests for the gaps that broke real Express (`express.static`) in
 * the VM: the request/response `socket` must be an EventEmitter (on-finished /
 * ee-first attach 'close'/'error' listeners), and fs must expose ReadStream /
 * WriteStream constructors (the `destroy` module does `x instanceof fs.ReadStream`).
 */
describe('http compat — socket is an EventEmitter (Express on-finished)', () => {
  it('req.socket and res.socket expose .on / .once / .emit', async () => {
    const portRegistry = new Map<number, VirtualRequestHandler>();
    const http = createHttp(portRegistry);
    let captured: { reqOn: string; resOn: string; attachOk: boolean } | null = null;

    const server = http.createServer((req: any, res: any) => {
      // on-finished attaches to res.socket for 'close'/'error' — must not throw.
      let attachOk = true;
      try {
        res.socket.on('close', () => {});
        req.socket.once('error', () => {});
      } catch {
        attachOk = false;
      }
      captured = { reqOn: typeof req.socket.on, resOn: typeof res.socket.on, attachOk };
      res.end('ok');
    });
    server.listen(3100);

    const handler = portRegistry.get(3100)!;
    const vRes: any = { statusCode: 200, headers: {}, body: '' };
    handler({ method: 'GET', url: '/', headers: {}, body: '' } as any, vRes);
    await vRes._donePromise;

    expect(captured).not.toBeNull();
    expect(captured!.reqOn).toBe('function');
    expect(captured!.resOn).toBe('function');
    expect(captured!.attachOk).toBe(true);
  });
});

describe('http compat — request body is delivered as bytes (express.json)', () => {
  it("emits the request body as a Buffer/ArrayBufferView, not a string", async () => {
    const portRegistry = new Map<number, VirtualRequestHandler>();
    const http = createHttp(portRegistry);
    let chunkIsString: boolean | null = null;
    let received = '';

    const server = http.createServer((req: any, res: any) => {
      req.on('data', (c: unknown) => {
        chunkIsString = typeof c === 'string';
        received += new TextDecoder().decode(c as Uint8Array);
      });
      req.on('end', () => res.end('ok'));
    });
    server.listen(3101);

    const handler = portRegistry.get(3101)!;
    const vRes: any = { statusCode: 200, headers: {}, body: '' };
    handler({ method: 'POST', url: '/', headers: { 'content-type': 'application/json' }, body: '{"text":"hi"}' } as any, vRes);
    await vRes._donePromise;

    expect(chunkIsString).toBe(false);
    expect(received).toBe('{"text":"hi"}');
  });
});

describe('http compat — request is async-iterable (for await…of req)', () => {
  it('streams the request body via Symbol.asyncIterator', async () => {
    const portRegistry = new Map<number, VirtualRequestHandler>();
    const http = createHttp(portRegistry);
    const server = http.createServer(async (req: any, res: any) => {
      let body = '';
      for await (const chunk of req) body += new TextDecoder().decode(chunk as Uint8Array);
      res.end('got:' + body);
    });
    server.listen(3102);
    const handler = portRegistry.get(3102)!;
    const vRes: any = { statusCode: 200, headers: {}, body: '' };
    handler({ method: 'POST', url: '/', headers: { 'content-length': '5' }, body: 'hello' } as any, vRes);
    await vRes._donePromise;
    const out = vRes.bodyBytes ? new TextDecoder().decode(vRes.bodyBytes) : vRes.body;
    expect(out).toBe('got:hello');
  });
});

describe('string_decoder — callable without new (iconv-lite / raw-body)', () => {
  it('works with new, and via legacy prototype inheritance (iconv-lite style)', () => {
    const bytes = new TextEncoder().encode('héllo');
    // new StringDecoder(enc)
    expect(new (StringDecoder as any)('utf-8').write(bytes)).toBe('héllo');

    // iconv-lite's InternalDecoder pattern: inherit the prototype, then call the
    // parent constructor as a plain function. An ES class would throw here.
    function Inherited(this: any, enc: string) { (StringDecoder as any).call(this, enc); }
    Inherited.prototype = Object.create((StringDecoder as any).prototype);
    const d: any = new (Inherited as any)('utf-8');
    expect(d.decoder).toBeTruthy();
    expect(d.write(bytes)).toBe('héllo');
  });
});

describe('fs compat — ReadStream / WriteStream constructors (Express send/destroy)', () => {
  it('exposes fs.ReadStream and fs.WriteStream', () => {
    const fs = createFs(new VFS(), '/');
    expect(typeof fs.ReadStream).toBe('function');
    expect(typeof fs.WriteStream).toBe('function');
  });

  it('createReadStream returns an instance of fs.ReadStream', () => {
    const vfs = new VFS();
    vfs.mkdir('/tmp');
    vfs.writeFile('/tmp/f.txt', 'hi');
    const fs = createFs(vfs, '/');
    const stream = fs.createReadStream('/tmp/f.txt');
    expect(stream instanceof fs.ReadStream).toBe(true);
  });
});
