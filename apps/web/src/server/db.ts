import { ensureDatabase, getDb, type Db } from '@col/db';

let ready = false;

/**
 * The process-wide database handle, migrated on first use.
 *
 * `ensureDatabase` only does work when the file is missing, so this costs one
 * `existsSync` per process. It means a fresh clone can run `pnpm dev` and reach
 * the create-memorial form without a separate setup step — the alternative is a
 * stack trace as someone's first impression of the product.
 */
export function db(): Db {
  if (!ready) {
    ensureDatabase();
    ready = true;
  }
  return getDb();
}
