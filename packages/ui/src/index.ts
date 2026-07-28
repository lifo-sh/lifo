export { Terminal } from './Terminal.js';
export { FileExplorer } from './FileExplorer.js';
export type { FileExplorerOptions, FileExplorerEntry, FileExplorerEvent, EditorProvider, EditorInstance } from './FileExplorer.js';
export { PreviewBrowser } from './PreviewBrowser.js';
export type { PreviewBrowserOptions } from './PreviewBrowser.js';
export { mountNoSwPreview, shimScript } from './preview-nosw.js';
// Reusable pieces for other embedders: the in-VM routing rules and the
// individually selectable fetch/XHR/WebSocket/asset patches.
export { resolveVmTarget } from './vm-routing.js';
export type { VmTarget } from './vm-routing.js';
export { buildPreviewShim, ALL_SHIMS } from './preview-shims.js';
export type { ShimName, PreviewShimOptions } from './preview-shims.js';
export type { NoSwPreviewHandle } from './preview-nosw.js';
// Re-export ITerminal type from core for convenience
export type { ITerminal } from '@lifo-sh/core';
