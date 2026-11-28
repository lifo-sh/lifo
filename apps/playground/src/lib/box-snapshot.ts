import { exportVfsSnapshot, importVfsSnapshot } from '@lifo-sh/core';
import type { InspectableBox } from '@/lib/process-inspector';

/**
 * Download the box's disk as a .tar.gz snapshot. Processes aren't captured —
 * only the VFS — so a restored box starts with the same files but no running
 * servers (re-run the dev command after restoring). Works for any box (in the
 * page or in a worker), so every example can snapshot, not just the preview ones.
 */
export async function downloadSnapshot(box: InspectableBox, name = 'lifo-box'): Promise<void> {
  const data = 'worker' in box ? await box.worker.exportSnapshot() : await exportVfsSnapshot(box.kernel.vfs);
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
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Prompt for a .tar.gz file and restore the box's disk from it. */
export function pickAndRestoreSnapshot(box: InspectableBox, onDone?: (ok: boolean) => void): void {
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
      if ('worker' in box) await box.worker.importSnapshot(buf);
      else await importVfsSnapshot(box.kernel.vfs, buf);
      onDone?.(true);
    } catch {
      onDone?.(false);
    }
  };
  input.click();
}
