/**
 * snapshot.ts — save and restore VM state as a portable .tar.gz
 *
 * ONE format across every environment. A snapshot is the archive
 * `exportVfsSnapshot()` produces: the VFS as tar entries, plus a
 * `lifo-snapshot.json` manifest carrying `cwd`, `env` and `mountPath`. So a file
 * saved here opens in the browser playground, and a file saved there restores
 * here.
 *
 * Previously this wrote a zip wrapping a JSON-serialized VFS — a second,
 * incompatible format, invented because the tar had nowhere to put session
 * state. That format is gone; an old zip is rejected with a clear message rather
 * than half-working.
 *
 * Commands:
 *   lifo snapshot save <id> [--output <file.tar.gz>]
 *   lifo snapshot restore <file.tar.gz|file.zip> [--mount <path>]
 *   lifo snapshot list
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

export const SNAPSHOTS_DIR = path.join(os.homedir(), '.lifo', 'snapshots');

/** A `.tar.gz` snapshot as produced by `exportVfsSnapshot()`. */
export interface SnapshotArchive {
  kind: 'archive';
  bytes: Uint8Array;
  /** Read from the manifest, when present. */
  cwd?: string;
  env?: Record<string, string>;
  mountPath?: string;
}

/**
 * gzip magic. Only used to give a clear error for a file that isn't a snapshot
 * archive (an old zip, say) instead of a confusing gunzip failure.
 */
function isGzip(buf: Buffer): boolean {
  return buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

/**
 * Connects to a running daemon's Unix socket, sends a snapshot request, and
 * returns the VFS/cwd/env data. Times out after 10 seconds.
 */
export function requestSnapshot(socketPath: string): Promise<SnapshotArchive> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let lineBuffer = '';
    let done = false;

    const timeout = setTimeout(() => {
      if (!done) {
        done = true;
        socket.destroy();
        reject(new Error('Snapshot request timed out after 10 s'));
      }
    }, 10_000);

    socket.once('connect', () => {
      socket.write(JSON.stringify({ type: 'snapshot' }) + '\n');
    });

    socket.on('data', (chunk: Buffer) => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'snapshot-data') {
            done = true;
            clearTimeout(timeout);
            socket.destroy();
            if (msg.format !== 'tar.gz' || typeof msg.data !== 'string') {
              reject(new Error(
                'This session was started by an older lifo build that returns the removed zip ' +
                'snapshot format. Restart the session to snapshot it.',
              ));
              return;
            }
            resolve({
              kind: 'archive',
              bytes: new Uint8Array(Buffer.from(msg.data, 'base64')),
              cwd: msg.cwd,
              env: msg.env,
              mountPath: msg.mountPath,
            });
          }
        } catch {
          // ignore malformed lines
        }
      }
    });

    socket.once('error', (err) => {
      if (!done) {
        done = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    socket.once('close', () => {
      if (!done) {
        done = true;
        clearTimeout(timeout);
        reject(new Error('Daemon closed the connection before sending snapshot data'));
      }
    });
  });
}

/** Writes a `.tar.gz` snapshot archive to disk. */
export function writeSnapshotArchive(bytes: Uint8Array, outputPath: string): void {
  fs.writeFileSync(outputPath, bytes);
}

/**
 * Reads a `.tar.gz` snapshot archive.
 *
 * The manifest is not parsed here — the daemon calls `importVfsSnapshot()`,
 * which reads it while restoring. This only validates that the file is an
 * archive at all, so a stale zip fails with something actionable.
 */
export function readSnapshotArchive(archivePath: string): Uint8Array {
  const buf = fs.readFileSync(archivePath);
  if (!isGzip(buf)) {
    throw new Error(
      `Not a lifo snapshot archive: ${archivePath}\n` +
      `Snapshots are .tar.gz files. Zip snapshots written by lifo <= 0.9.0 are no longer supported.`,
    );
  }
  return new Uint8Array(buf);
}

/**
 * Lists snapshot archives in `~/.lifo/snapshots/`.
 *
 * Matches `.tar.gz`, the extension `snapshot save` writes. It used to match
 * `.zip` — which meant that once saves moved to `.tar.gz`, `lifo snapshot list`
 * reported "No snapshots found" no matter how many you had. Zip snapshots are no
 * longer readable, so listing them would only offer files that can't be restored.
 *
 * `dir` is a parameter so this is testable without writing into a real home
 * directory.
 */
export function listSnapshots(dir: string = SNAPSHOTS_DIR): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.tar.gz'))
    .map((f) => path.join(dir, f));
}
