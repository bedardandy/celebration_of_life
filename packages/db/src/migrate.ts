import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createDb, resolveDbPath, type Db } from './client';

/** Absolute path to the committed drizzle-kit migration folder. */
export const MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'drizzle',
);

/** Apply all pending migrations to an already-open database handle. */
export function migrateDb(db: Db): void {
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

/**
 * Apply migrations to DATABASE_URL (or an explicit url), returning the resolved
 * file path. Used by `pnpm db:migrate` and by the dev-boot auto-migrate.
 */
export function runMigrations(databaseUrl?: string): { file: string } {
  const db = createDb(databaseUrl);
  try {
    migrateDb(db);
    return { file: resolveDbPath(databaseUrl) };
  } finally {
    db.$sqlite.close();
  }
}

/**
 * Dev convenience: create+migrate the database if the file is missing, so a
 * fresh clone can run `pnpm dev` without a separate setup step. No-ops when the
 * file already exists; production deploys run `pnpm db:migrate` explicitly.
 */
export function ensureDatabase(databaseUrl?: string): { migrated: boolean; file: string } {
  const file = resolveDbPath(databaseUrl);
  const missing = file === ':memory:' || !existsSync(file);
  if (missing) {
    runMigrations(databaseUrl);
    return { migrated: true, file };
  }
  return { migrated: false, file };
}
