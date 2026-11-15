/**
 * `@lifo-sh/core/client`: the page side of a box that runs in a Web Worker, without the box itself.
 *
 * A page that runs its boxes with `WorkerSandbox` needs only this: the worker client, the box-origin
 * frame helpers and the login hand-off. The kernel, shell, Node.js layer and their compilers load in
 * the worker (which imports `@lifo-sh/core`), so the page downloads and parses a fraction of core.
 */
export { WorkerSandbox } from './sandbox/worker/client.js';
export type { WorkerSandboxOptions, HostCommand, HostCommandContext } from './sandbox/worker/client.js';
export { openBoxFrame, serveBoxFrame } from './sandbox/worker/frame.js';
export type { BoxFrame, BoxFrameOptions, ServeBoxFrameOptions } from './sandbox/worker/frame.js';
export { RpcChannel } from './sandbox/worker/rpc.js';
export type { Endpoint as RpcEndpoint } from './sandbox/worker/rpc.js';
export { pageAuth } from './cloud/box-auth.js';
export type { BoxAuth } from './cloud/box-auth.js';
export type { ITerminal } from './terminal/ITerminal.js';
export type { CommandResult, RunOptions, SandboxFs, SnapshotOptions } from './sandbox/types.js';
