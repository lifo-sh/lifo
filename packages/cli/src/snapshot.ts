/**
 * snapshot.ts — save and restore VM state as a portable .zip file
 *
 * Format: a zip containing a single `snapshot.json` with:
 *   { version, savedAt, cwd, env, vfs }
 *
 * Commands:
 *   lifo snapshot save <id> [--output <file.zip>]
 *   lifo snapshot restore <file.zip> [--mount <path>]
 *   lifo snapshot list
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import AdmZip from 'adm-zip';
import type { SerializedNode } from '@lifo-sh/core';

export const SNAPSHOTS_DIR = path.join(os.homedir(), '.lifo', 'snapshots');

export interface SnapshotData {
  vfs: SerializedNode;
  cwd: string;
  env: Record<string, string>;
  /** Original host mount path at snapshot time. Used as restore default on same machine. */
  mountPath?: string;
}

interface SnapshotFile {
  version: 1;
  savedAt: string;
  cwd: string;
  env: Record<string, string>;
  vfs: SerializedNode;
  mountPath?: string;
}

/**
 * Connects to a running daemon's Unix socket, sends a snapshot request, and
 * returns the VFS/cwd/env data. Times out after 10 seconds.
 */
export function requestSnapshot(socketPath: string): Promise<SnapshotData> {
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
            resolve({ vfs: msg.vfs, cwd: msg.cwd, env: msg.env, mountPath: msg.mountPath });
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

/** Serializes snapshot data into a zip file at the given path. */
export function writeSnapshotZip(data: SnapshotData, outputPath: string): void {
  const payload: SnapshotFile = {
    version: 1,
    savedAt: new Date().toISOString(),
    cwd: data.cwd,
    env: data.env,
    vfs: data.vfs,
    mountPath: data.mountPath,
  };

  const zip = new AdmZip();
  zip.addFile('snapshot.json', Buffer.from(JSON.stringify(payload), 'utf-8'));
  zip.writeZip(outputPath);
}

/** Reads and validates a snapshot zip, returning the inner data. */
export function readSnapshotZip(zipPath: string): SnapshotData {
  const zip = new AdmZip(zipPath);
  const entry = zip.getEntry('snapshot.json');
  if (!entry) {
    throw new Error(`Invalid snapshot: no snapshot.json found in ${zipPath}`);
  }
  const raw = entry.getData().toString('utf-8');
  const parsed: SnapshotFile = JSON.parse(raw);

  if (parsed.version !== 1) {
    throw new Error(`Unsupported snapshot version: ${parsed.version}`);
  }
  if (!parsed.vfs || !parsed.cwd || !parsed.env) {
    throw new Error('Invalid snapshot: missing required fields (vfs, cwd, env)');
  }

  return { vfs: parsed.vfs, cwd: parsed.cwd, env: parsed.env, mountPath: parsed.mountPath };
}

/** Lists all .zip files in ~/.lifo/snapshots/. */
export function listSnapshots(): string[] {
  if (!fs.existsSync(SNAPSHOTS_DIR)) return [];
  return fs
    .readdirSync(SNAPSHOTS_DIR)
    .filter((f) => f.endsWith('.zip'))
    .map((f) => path.join(SNAPSHOTS_DIR, f));
}
