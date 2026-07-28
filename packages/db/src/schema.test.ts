import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from './client';
import { createTestDb } from './testing';
import { getById, insertOne, listAlive, softDeleteById, restoreById } from './helpers';
import { isUuid, newId } from './ids';
import { TABLE_NAMES, lifeStoryDocs, mediaAssets, memorials, magicTokens } from './schema';

let db: Db;
beforeEach(() => {
  db = createTestDb();
});
afterEach(() => {
  db.$sqlite.close();
});

function tableNames(d: Db): string[] {
  return (
    d.$sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
      .all() as { name: string }[]
  ).map((r) => r.name);
}

describe('migrations', () => {
  it('creates every table in the data model', () => {
    const present = new Set(tableNames(db));
    for (const name of TABLE_NAMES) expect(present.has(name), `missing table ${name}`).toBe(true);
  });

  it('creates the indexes the hot paths depend on', () => {
    const idx = (
      db.$sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(idx).toContain('jobs_status_run_after_idx');
    expect(idx).toContain('media_assets_memorial_curation_idx');
    expect(idx).toContain('magic_tokens_token_hash_idx');
  });
});

describe('ids', () => {
  it('generates time-ordered uuidv7 values', () => {
    const a = newId();
    const b = newId();
    expect(isUuid(a)).toBe(true);
    expect(a[14]).toBe('7');
    expect(a < b || a === b).toBe(true);
  });
});

describe('helpers', () => {
  it('inserts, reads back, soft deletes and restores', () => {
    const m = insertOne(db, memorials, { decedentName: 'Margaret Ellen Doyle' });
    expect(isUuid(m.id)).toBe(true);
    expect(m.status).toBe('draft');
    expect(m.traditionSlug).toBe('secular');
    expect(m.checklist).toEqual({});
    expect(getById(db, memorials, m.id)?.decedentName).toBe('Margaret Ellen Doyle');

    expect(listAlive(db, memorials)).toHaveLength(1);
    softDeleteById(db, memorials, m.id);
    expect(listAlive(db, memorials)).toHaveLength(0);
    expect(getById(db, memorials, m.id)?.deletedAt).toBeTypeOf('number');
    restoreById(db, memorials, m.id);
    expect(listAlive(db, memorials)).toHaveLength(1);
  });

  it('round-trips JSON columns through zod-shaped types', () => {
    const m = insertOne(db, memorials, { decedentName: 'Peggy' });
    const doc = insertOne(db, lifeStoryDocs, {
      memorialId: m.id,
      version: 1,
      doc: {
        subject: { fullName: 'Margaret Ellen Doyle' },
        structure: 'chrono',
        chapters: [],
        themes: ['hospitality'],
        toneNotes: 'warm, plain',
        coveragePhotoGaps: [],
      },
      createdBy: 'interview',
    });
    const back = getById(db, lifeStoryDocs, doc.id);
    expect(back?.doc.themes).toEqual(['hospitality']);
    expect(back?.doc.subject.fullName).toBe('Margaret Ellen Doyle');
  });

  it('enforces foreign keys and the token-hash uniqueness constraint', () => {
    expect(() =>
      insertOne(db, mediaAssets, {
        memorialId: 'does-not-exist',
        mime: 'image/jpeg',
        blobKey: 'x',
      }),
    ).toThrow(/FOREIGN KEY/i);

    const m = insertOne(db, memorials, { decedentName: 'Peggy' });
    insertOne(db, magicTokens, { memorialId: m.id, tokenHash: 'abc', kind: 'contributor' });
    expect(() =>
      insertOne(db, magicTokens, { memorialId: m.id, tokenHash: 'abc', kind: 'organizer-login' }),
    ).toThrow(/UNIQUE/i);
  });

  it('stamps createdAt/updatedAt as epoch milliseconds', () => {
    const before = Date.now();
    const m = insertOne(db, memorials, { decedentName: 'Peggy' });
    expect(m.createdAt).toBeGreaterThanOrEqual(before);
    expect(Number.isInteger(m.createdAt)).toBe(true);
  });
});
