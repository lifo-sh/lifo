/// <reference lib="webworker" />
// A Lifo box in its own Web Worker (the Isolation example). The page talks to it through
// WorkerSandbox; code in the box can't reach the page's DOM, storage or cookies.
import { serveSandbox, type RpcEndpoint } from '@lifo-sh/core';

serveSandbox(self as unknown as RpcEndpoint);
