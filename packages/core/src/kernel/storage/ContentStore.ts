/**
 * Synchronous, in-memory content-addressable store with LRU eviction.
 *
 * The VFS API is fully synchronous, so we need a sync cache for file content.
 * Large files (>= CHUNK_THRESHOLD) are split into fixed-size chunks and stored
 * here, keeping INodes lightweight (metadata-only, no inline data).
 *
 * The LRU eviction removes least-recently-accessed entries when the total
 * stored bytes exceed the configured budget.
 */

import { hashBytes } from './BlobStore.js';

// ─── Constants ───

/** Files at or above this size are chunked rather than stored inline.
 *  Set high to avoid LRU eviction silently losing file data during npm install
 *  (many packages installed back-to-back can exceed the ContentStore budget). */
export const CHUNK_THRESHOLD = 50 * 1024 * 1024; // 50 MB

/** Size of each chunk for large files. */
export const CHUNK_SIZE = 256 * 1024; // 256 KB

// ─── Chunk descriptor ───

export interface ChunkRef {
  hash: string;
  size: number;
}

// ─── ContentStore ───

interface CacheEntry {
  data: Uint8Array;
  lastAccess: number; // monotonic counter, NOT wall-clock
}

export class ContentStore {
  private cache = new Map<string, CacheEntry>();
  private accessCounter = 0;
  private totalBytes = 0;
  private maxBytes: number;

  constructor(maxBytes: number = 64 * 1024 * 1024) { // 64 MB default
    this.maxBytes = maxBytes;
  }

  /** Retrieve a blob by hash. Returns null if not in cache. */
  get(hash: string): Uint8Array | null {
    const entry = this.cache.get(hash);
    if (!entry) return null;
    entry.lastAccess = ++this.accessCounter;
    return entry.data;
  }

  /** Store a blob. Returns its content hash. Deduplicates by hash. */
  put(data: Uint8Array): string {
    const hash = hashBytes(data);
    if (this.cache.has(hash)) {
      this.cache.get(hash)!.lastAccess = ++this.accessCounter;
      return hash;
    }
    this.cache.set(hash, { data, lastAccess: ++this.accessCounter });
    this.totalBytes += data.byteLength;
    this.evict();
    return hash;
  }

  /** Remove a blob from the cache. */
  delete(hash: string): void {
    const entry = this.cache.get(hash);
    if (entry) {
      this.totalBytes -= entry.data.byteLength;
      this.cache.delete(hash);
    }
  }

  /** Check if a hash exists in the cache. */
  has(hash: string): boolean {
    return this.cache.has(hash);
  }

  /** Current total bytes in cache. */
  get size(): number {
    return this.totalBytes;
  }

  /** Number of entries in cache. */
  get count(): number {
    return this.cache.size;
  }

  // ─── Chunking helpers ───

  /**
   * Split data into chunks, store each, and return the chunk manifest.
   */
  storeChunked(data: Uint8Array): ChunkRef[] {
    const chunks: ChunkRef[] = [];
    for (let offset = 0; offset < data.byteLength; offset += CHUNK_SIZE) {
      const end = Math.min(offset + CHUNK_SIZE, data.byteLength);
      const chunk = data.subarray(offset, end);
      const hash = this.put(chunk);
      chunks.push({ hash, size: chunk.byteLength });
    }
    return chunks;
  }

  /**
   * Reassemble data from a chunk manifest.
   * Returns null if any chunk is missing from cache.
   */
  loadChunked(chunks: ChunkRef[]): Uint8Array | null {
    const totalSize = chunks.reduce((sum, c) => sum + c.size, 0);
    const result = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of chunks) {
      const data = this.get(chunk.hash);
      if (!data) return null;
      result.set(data, offset);
      offset += chunk.size;
    }
    return result;
  }

  /**
   * Remove all chunks in a manifest from the cache.
   */
  deleteChunked(chunks: ChunkRef[]): void {
    for (const chunk of chunks) {
      this.delete(chunk.hash);
    }
  }

  // ─── LRU eviction ───

  private evict(): void {
    if (this.totalBytes <= this.maxBytes) return;

    // Sort entries by lastAccess (oldest first) and evict until under budget
    const entries = Array.from(this.cache.entries())
      .sort((a, b) => a[1].lastAccess - b[1].lastAccess);

    for (const [hash, entry] of entries) {
      if (this.totalBytes <= this.maxBytes) break;
      this.totalBytes -= entry.data.byteLength;
      this.cache.delete(hash);
    }
  }
}
