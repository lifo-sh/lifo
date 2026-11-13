// @mercuryworkshop/wisp-js ships no types; vite-plugin-firefox uses only this much of it.
declare module '@mercuryworkshop/wisp-js/server' {
  import type { IncomingMessage } from 'node:http';
  import type { Duplex } from 'node:stream';
  export const server: {
    options: Record<string, unknown>;
    routeRequest(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  };
}
