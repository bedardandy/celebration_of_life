import { and, desc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { Db } from './client';

/** A table that follows our conventions: text `id` PK. */
type WithId = SQLiteTable & { id: SQLiteColumn };
/** A table that additionally supports soft delete. */
type SoftDeletable = WithId & { deletedAt: SQLiteColumn };

export function insertOne<T extends SQLiteTable>(
  db: Db,
  table: T,
  values: T['$inferInsert'],
): T['$inferSelect'] {
  const rows = db
    .insert(table)
    .values(values as never)
    .returning()
    .all() as T['$inferSelect'][];
  const row = rows[0];
  if (!row) throw new Error('insertOne: insert returned no row');
  return row;
}

export function insertMany<T extends SQLiteTable>(
  db: Db,
  table: T,
  values: T['$inferInsert'][],
): T['$inferSelect'][] {
  if (values.length === 0) return [];
  return db
    .insert(table)
    .values(values as never)
    .returning()
    .all() as T['$inferSelect'][];
}

export function getById<T extends WithId>(
  db: Db,
  table: T,
  id: string,
): T['$inferSelect'] | undefined {
  const rows = db
    .select()
    .from(table)
    .where(eq(table.id, id))
    .limit(1)
    .all() as T['$inferSelect'][];
  return rows[0];
}

export function updateById<T extends WithId>(
  db: Db,
  table: T,
  id: string,
  patch: Partial<T['$inferInsert']>,
): T['$inferSelect'] | undefined {
  const rows = db
    .update(table)
    .set(patch as never)
    .where(eq(table.id, id))
    .returning()
    .all() as T['$inferSelect'][];
  return rows[0];
}

export function deleteById<T extends WithId>(db: Db, table: T, id: string): number {
  return db.delete(table).where(eq(table.id, id)).run().changes;
}

/**
 * Soft delete = tombstone. Nothing in this product should vanish without an
 * undo; the real removal is a separate, explicit purge.
 */
export function softDeleteById<T extends SoftDeletable>(
  db: Db,
  table: T,
  id: string,
  at: number = Date.now(),
): T['$inferSelect'] | undefined {
  return updateById(db, table, id, { deletedAt: at } as Partial<T['$inferInsert']>);
}

export function restoreById<T extends SoftDeletable>(
  db: Db,
  table: T,
  id: string,
): T['$inferSelect'] | undefined {
  return updateById(db, table, id, { deletedAt: null } as Partial<T['$inferInsert']>);
}

/** List rows matching `where`, excluding tombstoned ones. */
export function listAlive<T extends SoftDeletable>(
  db: Db,
  table: T,
  where?: SQL,
  limit = 500,
): T['$inferSelect'][] {
  const clause = where ? and(where, isNull(table.deletedAt)) : isNull(table.deletedAt);
  return db.select().from(table).where(clause).limit(limit).all() as T['$inferSelect'][];
}

export function listWhere<T extends SQLiteTable>(
  db: Db,
  table: T,
  where?: SQL,
  limit = 500,
): T['$inferSelect'][] {
  const q = db.select().from(table);
  return (where ? q.where(where) : q).limit(limit).all() as T['$inferSelect'][];
}

export function countWhere<T extends SQLiteTable>(db: Db, table: T, where?: SQL): number {
  return listWhere(db, table, where, Number.MAX_SAFE_INTEGER).length;
}

export { and, desc, eq, inArray, isNull };
