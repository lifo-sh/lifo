// A Lifo box as a Cloudflare Durable Object, on production flags (no eval, no runtime wasm
// compilation): one box per name, /home/user/keep on the object's own SQLite (the same
// SqliteMountProvider Lifo Cloud uses), and `node` on QuickJS through the lifo-edge adapter.
import { DurableObject } from 'cloudflare:workers';
import { SqliteMountProvider, durableObjectSql } from '@lifo-sh/core';
import { newQuickJSWASMModuleFromVariant, newVariant } from 'quickjs-emscripten-core';
import RELEASE_SYNC from '@jitl/quickjs-wasmfile-release-sync';
import wasmModule from './quickjs.wasm';
import { createEdgeSandbox } from '../adapter/lifo-edge.js';

let quickjs;

export class LifoBox extends DurableObject {
  async box() {
    if (!this._box) {
      quickjs ??= await newQuickJSWASMModuleFromVariant(newVariant(RELEASE_SYNC, { wasmModule }));
      const box = await createEdgeSandbox({ quickjs });
      box.kernel.vfs.mkdir('/home/user/keep', { recursive: true });
      box.kernel.vfs.mount('/home/user/keep', new SqliteMountProvider(durableObjectSql(this.ctx.storage.sql)));
      this._box = box;
    }
    return this._box;
  }
  async fetch(request) {
    const cmd = new URL(request.url).searchParams.get('cmd') || 'ls -la /home/user/keep';
    const box = await this.box();
    const r = await box.commands.run(cmd, { cwd: '/home/user/keep' });
    return Response.json({ cmd, exit: r.exitCode, out: (r.stdout + r.stderr).trim(), edge: box.edge, dbBytes: this.ctx.storage.sql.databaseSize });
  }
}

export default {
  fetch(request, env) {
    const name = new URL(request.url).searchParams.get('box') || 'demo';
    return env.BOX.get(env.BOX.idFromName(name)).fetch(request);
  },
};
