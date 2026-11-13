import { DOMParser } from 'linkedom';
import type { CommandContext } from '@lifo-sh/core';

export const parseHtml = (html: string) => new DOMParser().parseFromString(html, 'text/html') as unknown as Document;

export const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/** A minimal CommandContext that records output. */
export function ctx(args: string[], extra: Partial<CommandContext> = {}) {
  let stdout = '';
  let stderr = '';
  const c = {
    args,
    env: {},
    cwd: '/home/user',
    vfs: {} as CommandContext['vfs'],
    stdout: { write: (s: string) => void (stdout += s) },
    stderr: { write: (s: string) => void (stderr += s) },
    signal: new AbortController().signal,
    ...extra,
  } as CommandContext;
  return { c, out: () => strip(stdout), err: () => strip(stderr) };
}
