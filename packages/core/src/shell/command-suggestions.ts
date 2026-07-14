/**
 * "You typed X, but the Lifo way is Y" — command redirects + notes.
 *
 * Some tools can't run in Lifo (e.g. the Supabase CLI needs Docker) but have a
 * drop-in that runs in the VM (tinbase, Supabase-compatible). For those we print
 * a one-line note and transparently run the equivalent:
 *     supabase <args>      →  npx tinbase <args>
 *     npx supabase <args>  →  npx tinbase <args>
 * Tools with no in-VM equivalent (docker) get a note only.
 * Keep this list short and honest.
 */
interface Entry {
  /** argv prefix to run instead of a bare command (undefined = note only). */
  runAs?: string[];
  /** package name to substitute for `npx <pkg>` (undefined = no npx redirect). */
  pkg?: string;
  /** one-line note (shown without the 💡 prefix here; format() adds it). */
  msg: string;
}

const MAP: Record<string, Entry> = {
  supabase: {
    runAs: ['npx', 'tinbase'],
    pkg: 'tinbase',
    msg: 'Lifo has no Supabase CLI (it needs Docker) — running tinbase instead (Supabase-compatible, in the VM). See the "Supabase (tinbase)" example.',
  },
  docker: {
    msg: "Lifo doesn't run Docker (no native containers) — real stacks run directly in the VM. See the examples.",
  },
  'docker-compose': {
    msg: "Lifo doesn't run Docker Compose — run each service directly in the VM. See the examples.",
  },
};

function format(msg: string): string {
  return `💡 ${msg}`;
}

export interface CommandRedirect {
  /** argv prefix to run instead, e.g. ['npx','tinbase']; undefined = note only. */
  runAs?: string[];
  /** the note to print (💡-prefixed). */
  message: string;
}

/** Redirect/note for a bare command the user ran (e.g. `supabase`). */
export function commandRedirect(name: string): CommandRedirect | null {
  const e = MAP[name.toLowerCase()];
  return e ? { runAs: e.runAs, message: format(e.msg) } : null;
}

/** For `npx <pkg>`: the replacement package + note, or null (e.g. supabase→tinbase). */
export function npxRedirect(pkg: string): { to: string; message: string } | null {
  const e = MAP[pkg.toLowerCase()];
  return e?.pkg ? { to: e.pkg, message: format(e.msg) } : null;
}

/** For `npm install <pkg>`: a note (install isn't redirected), or null.
 *  Strips a version tag and guards scoped names (@supabase/supabase-js is fine). */
export function suggestForPackage(spec: string): string | null {
  const at = spec.lastIndexOf('@');
  const base = at > 0 ? spec.slice(0, at) : spec;
  const e = MAP[base.toLowerCase()] ?? MAP[spec.toLowerCase()];
  return e ? format(e.msg) : null;
}
