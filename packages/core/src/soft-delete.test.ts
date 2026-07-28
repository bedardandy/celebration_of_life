import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, getById, insertOne, memorials, memoryNotes, type Db } from '@col/db';
import {
  SOFT_DELETABLE,
  UNDO_WINDOW_SEC,
  isSoftDeletableKind,
  restore,
  softDelete,
} from './soft-delete';

const NOW = 1_800_000_000_000;
let db: Db;
let memorialId: string;

beforeEach(() => {
  db = createTestDb();
  memorialId = insertOne(db, memorials, { decedentName: 'Ruth' }).id;
});

describe('softDelete', () => {
  it('leaves a tombstone rather than removing the row', () => {
    const result = softDelete(db, 'memorial', memorialId, NOW);
    expect(result).toMatchObject({ kind: 'memorial', id: memorialId, deletedAt: NOW });
    const row = getById(db, memorials, memorialId);
    expect(row).toBeDefined();
    expect(row?.deletedAt).toBe(NOW);
  });

  it('is undone completely by restore', () => {
    softDelete(db, 'memorial', memorialId, NOW);
    expect(restore(db, 'memorial', memorialId)).toBe(true);
    expect(getById(db, memorials, memorialId)?.deletedAt).toBeNull();
  });

  it('works for every kind the interface can remove', () => {
    const note = insertOne(db, memoryNotes, { memorialId, text: 'She always had the radio on.' });
    expect(softDelete(db, 'memory', note.id, NOW)?.message).toBe('Memory removed.');
    expect(getById(db, memoryNotes, note.id)?.text).toBe('She always had the radio on.');
    expect(restore(db, 'memory', note.id)).toBe(true);
  });

  it('reports nothing for an id that is not there, instead of throwing', () => {
    expect(softDelete(db, 'memorial', 'no-such-id', NOW)).toBeUndefined();
    expect(restore(db, 'memorial', 'no-such-id')).toBe(false);
  });

  it('offers a window long enough to notice and react', () => {
    expect(UNDO_WINDOW_SEC).toBeGreaterThanOrEqual(5);
    expect(UNDO_WINDOW_SEC).toBeLessThanOrEqual(15);
  });

  it('only accepts kinds the registry knows', () => {
    expect(isSoftDeletableKind('memorial')).toBe(true);
    expect(isSoftDeletableKind('participants')).toBe(false);
    expect(isSoftDeletableKind(undefined)).toBe(false);
    expect(Object.keys(SOFT_DELETABLE).sort()).toEqual([
      'memorial',
      'memory',
      'photo',
      'slideshow',
    ]);
  });

  it('says what happened without a warning tone', () => {
    const note = insertOne(db, memoryNotes, { memorialId, text: 'x' });
    const messages = [
      softDelete(db, 'memorial', memorialId, NOW)?.message,
      softDelete(db, 'memory', note.id, NOW)?.message,
    ];
    for (const message of messages) {
      expect(message).toBeDefined();
      expect(message).not.toMatch(/permanently|cannot|warning|careful/i);
      expect((message as string).length).toBeLessThan(60);
    }
  });
});
