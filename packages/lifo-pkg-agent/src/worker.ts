// The web worker side of `webllmEngine({ worker })`. A host's worker file is one line:
//   import 'lifo-pkg-agent/worker';
import { WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm';

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg: MessageEvent) => handler.onmessage(msg);
