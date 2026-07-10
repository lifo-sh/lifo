import type { Sandbox } from '@lifo-sh/core';

/**
 * Download the box's disk as a .tar.gz snapshot. Processes aren't captured —
 * only the VFS — so a restored box starts with the same files but no running
 * servers (re-run the dev command after restoring).
 */
export async function downloadSnapshot(sandbox: Sandbox, name = 'lifo-box'): Promise<void> {
  const data = await sandbox.exportSnapshot();
  // Copy into a fresh ArrayBuffer so the Blob type is exactly BlobPart (the VFS
  // may hand back a view over a larger buffer).
  const buf = data.slice();
  const blob = new Blob([buf], { type: 'application/gzip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}-snapshot.tar.gz`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the download has started.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Prompt for a .tar.gz file and restore the box's disk from it. */
export function pickAndRestoreSnapshot(sandbox: Sandbox, onDone?: (ok: boolean) => void): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.gz,.tgz,.tar,application/gzip';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) {
      onDone?.(false);
      return;
    }
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      await sandbox.importSnapshot(buf);
      onDone?.(true);
    } catch {
      onDone?.(false);
    }
  };
  input.click();
}
