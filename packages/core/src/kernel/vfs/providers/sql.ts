/**
 * The smallest synchronous SQL surface the SQLite mount needs, shaped like a Durable Object's
 * `ctx.storage.sql`: `exec(query, ...params)` returns the rows. Adapters below wrap `node:sqlite`
 * (Node hosts, tests) and Durable Object SQL (Lifo Cloud).
 *
 * Durability contract: every write made during one event-loop turn commits together, at the end
 * of that turn (or at `flush()`). A crash loses at most the turn in progress, never a turn that
 * finished. Durable Objects give this on their own; the node:sqlite adapter does it by opening a
 * transaction on the first write of a turn and committing it on the next tick.
 */

export type SqlValue = string | number | null | Uint8Array;
export type SqlRow = Record<string, unknown>;

export interface SyncSqlCursor extends Iterable<SqlRow> {
  toArray(): SqlRow[];
}

export interface SyncSql {
  exec(query: string, ...params: SqlValue[]): SyncSqlCursor;
  /** Commit what this turn wrote now instead of at the end of the turn. */
  flush?(): void;
}

function cursor(rows: SqlRow[]): SyncSqlCursor {
  return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
}

const EMPTY = cursor([]);

const isRead = (query: string): boolean => /^\s*(select|with|pragma\s+\w+\s*$)/i.test(query);

/** The parts of node:sqlite's `DatabaseSync` the adapter uses. */
export interface NodeSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown };
  readonly isTransaction?: boolean;
  readonly isOpen?: boolean;
}

export interface NodeSqliteOptions {
  /**
   * 'turn' (default): writes of one event-loop turn share a transaction, committed on the next
   * tick or at flush(). 'statement': SQLite's autocommit, each write its own transaction (slow:
   * a sync per write).
   */
  batch?: 'turn' | 'statement';
  /** Set WAL journaling with synchronous=NORMAL (default true): fast commits, crash-safe. */
  wal?: boolean;
}

/**
 * A `SyncSql` over node:sqlite (`new DatabaseSync(file)`). Pass the open database; this module
 * never imports node:sqlite itself, so it stays safe to bundle for browsers.
 */
export function nodeSqlite(db: NodeSqliteDatabase, opts: NodeSqliteOptions = {}): SyncSql & { flush(): void } {
  if (opts.wal !== false) {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  }
  const statements = new Map<string, ReturnType<NodeSqliteDatabase['prepare']>>();
  const prepared = (query: string) => {
    let s = statements.get(query);
    if (!s) {
      s = db.prepare(query);
      statements.set(query, s);
    }
    return s;
  };
  const turn = opts.batch !== 'statement';
  let open = false;

  const flush = () => {
    if (!open) return;
    open = false;
    // Closed (the host is shutting down) or rolled back by someone else: nothing left to commit.
    if (db.isOpen === false || db.isTransaction === false) return;
    db.exec('COMMIT');
  };
  const schedule: (fn: () => void) => void =
    typeof setImmediate === 'function' ? (fn) => void setImmediate(fn) : (fn) => void setTimeout(fn, 0);

  return {
    exec(query, ...params) {
      const args = params.map((p) => (p === undefined ? null : p));
      if (isRead(query)) return cursor(prepared(query).all(...args) as SqlRow[]);
      if (turn && !open) {
        db.exec('BEGIN');
        open = true;
        schedule(flush);
      }
      prepared(query).run(...args);
      return EMPTY;
    },
    flush,
  };
}

/** The parts of a Durable Object's `ctx.storage.sql` the adapter uses. */
export interface DurableObjectSqlStorage {
  exec(query: string, ...bindings: unknown[]): Iterable<SqlRow> & { toArray(): SqlRow[] };
}

/**
 * A `SyncSql` over a Durable Object's `ctx.storage.sql`. Durable Objects already commit each
 * turn's writes together; this only binds blobs the way they take them (ArrayBuffer).
 */
export function durableObjectSql(sql: DurableObjectSqlStorage): SyncSql {
  return {
    exec(query, ...params) {
      const bindings = params.map((p) =>
        p instanceof Uint8Array ? p.buffer.slice(p.byteOffset, p.byteOffset + p.byteLength) : p === undefined ? null : p,
      );
      return sql.exec(query, ...bindings);
    },
  };
}
