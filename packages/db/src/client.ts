import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { resolveFromRoot } from './paths';
import { schema } from './schema';

export type Db = BetterSQLite3Database<typeof schema> & { $sqlite: Database.Database };

export const DEFAULT_DATABASE_URL = 'file:./data/app.db';

/**
 * Accepts either a plain path or a `file:` URL (matching the DATABASE_URL
 * convention we will keep when this becomes a Postgres URL).
 * `:memory:` is passed through for tests.
 *
 * Relative paths resolve against the repo root rather than the current working
 * directory, so the web app, the worker and `pnpm db:migrate` all open the same
 * file no matter where they were started.
 */
export function resolveDbPath(
  databaseUrl: string = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
): string {
  const raw = databaseUrl.replace(/^file:\/\//, '').replace(/^file:/, '');
  if (raw === ':memory:' || raw === '') return ':memory:';
  return resolveFromRoot(raw);
}

export function openDatabase(databaseUrl?: string): Database.Database {
  const file = resolveDbPath(databaseUrl);
  if (file !== ':memory:') {
    mkdirSync(path.dirname(file), { recursive: true });
  }
  const sqlite = new Database(file);
  // WAL keeps the poller and the web process out of each other's way.
  if (file !== ':memory:') sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  return sqlite;
}

export function createDb(databaseUrl?: string): Db {
  const sqlite = openDatabase(databaseUrl);
  // The raw handle stays reachable for pragmas, raw SQL and close().
  return Object.assign(drizzle(sqlite, { schema }), { $sqlite: sqlite });
}

let singleton: Db | undefined;

/** Process-wide handle. Tests should call `createDb(':memory:')` instead. */
export function getDb(): Db {
  singleton ??= createDb();
  return singleton;
}

export function closeDb(): void {
  singleton?.$sqlite.close();
  singleton = undefined;
}
