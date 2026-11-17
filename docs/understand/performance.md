# Performance

Lifo has nothing to boot but JavaScript objects, so a box starts in milliseconds and the
whole runtime is about 0.3 MB gzipped. Measure it in your own browser:

```js live
import { Sandbox } from '@lifo-sh/core';

const times = [];
for (let i = 0; i < 10; i++) {
  const t0 = performance.now();
  await Sandbox.create();
  times.push(performance.now() - t0);
}
times.sort((a, b) => a - b);
console.log(`median boot of 10 boxes: ${times[5].toFixed(2)} ms`);

const box = await Sandbox.create();
let t = performance.now();
await box.commands.run('echo hi | tr a-z A-Z');
console.log(`a shell pipeline: ${(performance.now() - t).toFixed(1)} ms`);

t = performance.now();
await box.commands.run('node -e "1 + 1"');
console.log(`a short node program: ${(performance.now() - t).toFixed(0)} ms`);
```

## Measured

From `bench/` in this repo, in the same headless Chromium for both browser rows:

| | Cold start to a box with `node` and `npm` | Runtime size |
|---|---|---|
| Lifo in a browser tab | ~27 ms (26 ms to load, under 1 ms to boot) | ~0.3 MB gzipped |
| Lifo in Node.js | ~0.5 ms | ~0.3 MB |
| WebContainers in a browser tab | ~6.6 s (1.0 s to load, 5.6 s to boot) | ~75-85 MB (vendor figure) |

For comparison, cloud microVM sandboxes publish cold starts of about 150 to 300 ms (E2B) up
to a few seconds, before the network round trip.

`bench/COMPARISON.md` has the method and the scripts; `bench/RESULTS.md` has more runs.

## What takes time in practice

Booting is never the slow part. These are:


- **`npm install`** downloads packages over the network into the box's memory. A Vite + React
  project takes seconds. Ship a snapshot with `node_modules` already installed to skip it.
- **A dev server's first build.** Vite starts in well under a second; Metro's first bundle of
  an Expo app takes several.
- **Long computations**, which share one thread with the page (see
  [Limitations](limitations.md)).
