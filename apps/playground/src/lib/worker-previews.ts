import type { WorkerSandbox } from '@lifo-sh/core';

// Previews for a box in a Web Worker. The preview service worker routes /_sw/<boxId>/<port>/ to
// whoever announced that box id over a MessageChannel. For a page box that's a
// ServiceWorkerBridge on its kernel; for a worker box the channel goes into the box's worker
// (WorkerSandbox.servePreviews), which answers preview requests itself. The service worker
// forgets every channel when it restarts and asks for them again ("lifo-need-host").

const hosts = new Set<{ announce(reg: ServiceWorkerRegistration): Promise<void> }>();
let registration: Promise<ServiceWorkerRegistration> | null = null;

function waitForActive(reg: ServiceWorkerRegistration): Promise<ServiceWorker> {
  if (reg.active) return Promise.resolve(reg.active);
  return new Promise((resolve) => {
    const check = () => reg.active && resolve(reg.active);
    const track = (w: ServiceWorker | null) => w?.addEventListener('statechange', check);
    track(reg.installing);
    track(reg.waiting);
    reg.addEventListener('updatefound', () => track(reg.installing));
  });
}

/**
 * Serve `box`'s previews at /_sw/<boxId>/<port>/. Resolves with the box id, or null when this
 * browser has no service worker. `disconnect()` stops re-announcing it (the box is going away).
 */
export async function connectWorkerPreviews(box: WorkerSandbox): Promise<{ boxId: string; disconnect(): void } | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    registration ??= navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`, { scope: '/_sw/' })
      .then(async (reg) => {
        await waitForActive(reg);
        navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
          if ((e.data as { type?: string } | null)?.type === 'lifo-need-host') {
            hosts.forEach((h) => void h.announce(reg).catch(() => {}));
          }
        });
        return reg;
      });
    const reg = await registration;
    let boxId = '';
    const host = {
      async announce(r: ServiceWorkerRegistration) {
        const channel = new MessageChannel();
        boxId = await box.servePreviews(channel.port1);
        r.active?.postMessage({ type: 'lifo-connect', boxId }, [channel.port2]);
      },
    };
    await host.announce(reg);
    hosts.add(host);
    return { boxId, disconnect: () => hosts.delete(host) };
  } catch (error) {
    console.warn('[lifo] previews for the worker box are unavailable:', error);
    return null;
  }
}
