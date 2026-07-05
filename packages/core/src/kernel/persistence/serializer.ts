import type { INode } from '../vfs/types.js';

export interface SerializedChunkRef {
  h: string;  // hash
  s: number;  // size
}

export interface SerializedNode {
  t: 'f' | 'd';
  n: string;
  d?: string;              // base64 data (small files only)
  c?: SerializedNode[];     // children (dirs only)
  ct: number;
  mt: number;
  m: number;
  mi?: string;             // MIME type (files only)
  br?: string;             // blob store ref (content hash)
  ch?: SerializedChunkRef[]; // chunk manifest (large files)
  sz?: number;             // stored size (when chunked)
}

const EXCLUDED_PREFIXES = ['proc', 'dev', 'mnt'];

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64(str: string): Uint8Array {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function serialize(root: INode): SerializedNode {
  return serializeNode(root, true);
}

function serializeNode(node: INode, isRoot: boolean): SerializedNode {
  if (node.type === 'file') {
    const s: SerializedNode = {
      t: 'f',
      n: node.name,
      ct: node.ctime,
      mt: node.mtime,
      m: node.mode,
    };
    if (node.chunks && node.chunks.length > 0) {
      // Chunked large file: store manifest, not data
      s.ch = node.chunks.map((c) => ({ h: c.hash, s: c.size }));
      if (node.storedSize !== undefined) {
        s.sz = node.storedSize;
      }
    } else if (node.data.length > 0) {
      s.d = toBase64(node.data);
    }
    if (node.mime) {
      s.mi = node.mime;
    }
    if (node.blobRef) {
      s.br = node.blobRef;
    }
    return s;
  }

  const children: SerializedNode[] = [];
  for (const [name, child] of node.children) {
    // Exclude virtual filesystem directories at root level
    if (isRoot && EXCLUDED_PREFIXES.includes(name)) continue;
    children.push(serializeNode(child, false));
  }

  const s: SerializedNode = {
    t: 'd',
    n: node.name,
    ct: node.ctime,
    mt: node.mtime,
    m: node.mode,
  };
  if (children.length > 0) {
    s.c = children;
  }
  return s;
}

export function deserialize(data: SerializedNode): INode {
  return deserializeNode(data);
}

function deserializeNode(data: SerializedNode): INode {
  const children = new Map<string, INode>();
  if (data.t === 'd' && data.c) {
    for (const child of data.c) {
      const node = deserializeNode(child);
      children.set(node.name, node);
    }
  }

  const node: INode = {
    type: data.t === 'f' ? 'file' : 'directory',
    name: data.n,
    data: data.d ? fromBase64(data.d) : new Uint8Array(0),
    children,
    ctime: data.ct,
    mtime: data.mt,
    mode: data.m,
  };
  if (data.mi) {
    node.mime = data.mi;
  }
  if (data.br) {
    node.blobRef = data.br;
  }
  if (data.ch) {
    node.chunks = data.ch.map((c) => ({ hash: c.h, size: c.s }));
  }
  if (data.sz !== undefined) {
    node.storedSize = data.sz;
  }
  return node;
}
