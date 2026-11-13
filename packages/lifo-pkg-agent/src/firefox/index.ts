// lifo-pkg-agent/firefox: a real Firefox (Gecko in WebAssembly) for `browser`, shown in your page.
//
//   import { mountFirefox, createFirefoxBrowserCommand } from 'lifo-pkg-agent/firefox';
//   import { createBrowserCommand } from 'lifo-pkg-agent';
//   const ff = mountFirefox(paneElement, { wispUrl: async () => (await (await fetch('/api/wisp-token')).json()).url });
//   box.commands.register('browser', createFirefoxBrowserCommand(() => ff, { fallback: createBrowserCommand() }));
//
// The page and the release (served at /firefox/) must be cross-origin isolated, and Firefox needs
// a WISP relay. See docs/build/agents.md.
import { FirefoxFrame, type FirefoxFrameOptions } from './frame.js';

export { FirefoxFrame, canRunFirefox, type FirefoxFrameOptions, type FirefoxStatus, type PageInfo } from './frame.js';
export { createFirefoxBrowserCommand, type FirefoxBrowserOptions } from './command.js';

/** Creates the iframe in `container` (filling it) and boots Firefox in it. */
export function mountFirefox(container: HTMLElement, opts: FirefoxFrameOptions): FirefoxFrame {
  const iframe = document.createElement('iframe');
  iframe.title = 'Firefox';
  iframe.setAttribute('allow', 'cross-origin-isolated; clipboard-read; clipboard-write');
  iframe.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;background:#1c1b22';
  container.appendChild(iframe);
  return new FirefoxFrame(iframe, opts);
}
