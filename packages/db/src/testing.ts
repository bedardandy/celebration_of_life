import { createDb, type Db } from './client';
import { migrateDb } from './migrate';

/**
 * A migrated in-memory database. Used by every package's tests so nothing
 * touches the developer's real data/app.db.
 */
export function createTestDb(): Db {
  const db = createDb(':memory:');
  migrateDb(db);
  return db;
}
