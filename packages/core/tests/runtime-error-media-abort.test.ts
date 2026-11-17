import { describe, it, expect } from 'vitest';
import { SM_RESOLVER_AND_ERROR_HANDLERS } from '../src/commands/system/browser-metro-shims';

// Runs the preview iframe's error script against a stub window and returns what it posts to the editor.
function run(reasons: unknown[]) {
  const listeners: Record<string, (e: unknown) => void> = {};
  const posted: Array<{ type: string; payload: { message: string } }> = [];
  const win: Record<string, unknown> = {
    addEventListener: (t: string, f: (e: unknown) => void) => { listeners[t] = f; },
    parent: { postMessage: (m: { type: string; payload: { message: string } }) => posted.push(m) },
  };
  new Function('window', SM_RESOLVER_AND_ERROR_HANDLERS)(win);
  for (const r of reasons) listeners.unhandledrejection?.({ reason: r });
  return posted;
}

const abort = (message: string) => Object.assign(new Error(message), { name: 'AbortError' });

describe('preview runtime errors', () => {
  it("ignores a media element's interrupted play() (AbortError), and still reports the next real error", () => {
    const posted = run([
      abort('The play() request was interrupted by a new load request. https://goo.gl/LdLk22'),
      abort('The play() request was interrupted by a call to pause(). https://goo.gl/LdLk22'),
      new Error('boom'),
    ]);
    expect(posted).toHaveLength(1);
    expect(posted[0].payload.message).toContain('boom');
  });

  it('still reports other AbortErrors (a fetch the app aborted and did not handle)', () => {
    const posted = run([abort('signal is aborted without reason')]);
    expect(posted).toHaveLength(1);
  });
});
