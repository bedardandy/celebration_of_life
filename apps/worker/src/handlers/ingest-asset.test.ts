/**
 * Ingest, end to end, against the real fixture photos.
 *
 * Everything here goes through the queue rather than calling the handler
 * directly, because the parts that matter in the small hours are the ones
 * around the edges: what a retry does, what a poison file does, and whether one
 * bad upload can stop the other seven.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  and,
  assetVariants,
  createTestDb,
  eq,
  enqueue,
  getById,
  insertOne,
  listWhere,
  mediaAssets,
  memorials,
  newId,
  type Db,
  type Memorial,
} from '@col/db';
import { blobKeys, LocalDiskStore } from '@col/storage';
import { setIngestBlobStore } from './index';
import { drain, runOnce } from '../runner';
import type { WorkerConfig } from '../config';
import type { Logger } from '../log';

const silent: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => silent,
};

const config: WorkerConfig = {
  workerId: 'ingest-test',
  pollIntervalMs: 5,
  leaseMs: 30_000,
  maxAttempts: 3,
};

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'fixtures',
  'photos',
);

let db: Db;
let memorial: Memorial;
let workdir: string;
let store: LocalDiskStore;

beforeEach(() => {
  db = createTestDb();
  memorial = insertOne(db, memorials, {
    decedentName: 'Ruth Kelleher',
    birthYear: 1938,
    deathYear: 2026,
  });
  workdir = mkdtempSync(path.join(tmpdir(), 'col-ingest-'));
  store = new LocalDiskStore(workdir);
  setIngestBlobStore(store);
});

afterEach(() => {
  setIngestBlobStore(undefined);
  db.$sqlite.close();
  rmSync(workdir, { recursive: true, force: true });
});

/** Upload a fixture the way the web route does: blob first, then row and job. */
async function upload(
  file: string,
  options: { mime?: string; participantId?: string } = {},
): Promise<string> {
  const assetId = newId();
  const bytes = await readFile(path.join(FIXTURES, file));
  const mime = options.mime ?? (file.endsWith('.heic') ? 'image/heic' : 'image/jpeg');
  const key = blobKeys.original(memorial.id, assetId, file.split('.').pop() as string);
  await store.put(key, bytes, mime);

  insertOne(db, mediaAssets, {
    id: assetId,
    memorialId: memorial.id,
    uploadedByParticipantId: options.participantId ?? null,
    originalFilename: file,
    mime,
    byteSize: bytes.byteLength,
    blobKey: key,
  });
  enqueue(db, { type: 'ingest-asset', memorialId: memorial.id, assetId, blobKey: key });
  return assetId;
}

const variantsOf = (assetId: string) =>
  listWhere(db, assetVariants, eq(assetVariants.assetId, assetId));

describe('ingesting a photo', () => {
  it('produces three variants, a hash, a quality score and an upright frame', async () => {
    const assetId = await upload('07-sideways.jpg');

    const result = await runOnce({ db, config, logger: silent });
    expect(result.status).toBe('done');

    const asset = getById(db, mediaAssets, assetId);
    expect(asset?.ingestState).toBe('ready');
    expect(asset?.ingestError).toBeNull();
    // 640×480 tagged "rotate 90" is a 480×640 photograph.
    expect(asset?.width).toBe(480);
    expect(asset?.height).toBe(640);
    expect(asset?.phash).toMatch(/^[01]{64}$/);
    expect(asset?.qualityScore).toBeGreaterThan(0.5);
    expect(asset?.curationState).toBe('pending');

    const variants = variantsOf(assetId);
    expect(variants.map((v) => v.kind).sort()).toEqual(['render2400', 'thumb320', 'web1600']);
    for (const variant of variants) {
      expect(variant.mime).toBe('image/jpeg');
      expect(variant.byteSize).toBeGreaterThan(0);
      expect(await store.exists(variant.blobKey)).toBe(true);
      // Keys stay under the memorial prefix, so a hard delete is one call.
      expect(variant.blobKey.startsWith(`memorial/${memorial.id}/`)).toBe(true);
    }
  });

  it('converts a HEIC into something a browser can show', async () => {
    const assetId = await upload('08-phone.heic');
    await runOnce({ db, config, logger: silent });

    const asset = getById(db, mediaAssets, assetId);
    expect(asset?.ingestState).toBe('ready');
    // The original is untouched; the derived variants are JPEG.
    expect(asset?.mime).toBe('image/heic');
    expect(variantsOf(assetId).every((v) => v.mime === 'image/jpeg')).toBe(true);
    expect(await store.exists(asset?.blobKey as string)).toBe(true);
  });

  it('flags a blurry photo without hiding it', async () => {
    const blurry = await upload('06-blurry.jpg');
    const sharp = await upload('01-portrait.jpg');
    await drain({ db, config, logger: silent });

    const blurred = getById(db, mediaAssets, blurry);
    expect(blurred?.blurScore).toBeLessThan(0.25);
    expect(blurred?.curationState).toBe('pending');
    expect(blurred?.deletedAt).toBeNull();
    expect(getById(db, mediaAssets, sharp)?.blurScore).toBeGreaterThan(0.25);
  });

  it('groups two shots of one moment and picks the sharper one', async () => {
    const first = await upload('04-garden.jpg');
    const second = await upload('05-garden-near-duplicate.jpg');
    const unrelated = await upload('02-beach.jpg');
    await drain({ db, config, logger: silent });

    const a = getById(db, mediaAssets, first);
    const b = getById(db, mediaAssets, second);
    const c = getById(db, mediaAssets, unrelated);

    expect(a?.dupeGroupId).toBeTruthy();
    expect(b?.dupeGroupId).toBe(a?.dupeGroupId);
    expect(c?.dupeGroupId).toBeNull();

    const representatives = [a, b].filter((x) => x?.dupeRepresentative);
    expect(representatives).toHaveLength(1);
    const best = Math.max(a?.qualityScore ?? 0, b?.qualityScore ?? 0);
    expect(representatives[0]?.qualityScore).toBe(best);
  });

  it('reads a capture time and files the photo under a decade', async () => {
    const assetId = await upload('03-wedding.jpg');
    // Stand in for a camera that wrote a date: the fixture has none.
    const withDate = getById(db, mediaAssets, assetId);
    expect(withDate?.eraGuess).toBeNull();

    await runOnce({ db, config, logger: silent });
    const done = getById(db, mediaAssets, assetId);
    // No EXIF date on the fixture, so it lands in "when was this?" — which is a
    // normal outcome, not a failure.
    expect(done?.capturedAt).toBeNull();
    expect(done?.eraGuess).toBeNull();
    expect(done?.ingestState).toBe('ready');
  });
});

describe('when something is wrong with the file', () => {
  it('parks a file that is not a photo, and says so in plain words', async () => {
    const assetId = await upload('09-not-a-photo.jpg');
    const result = await runOnce({ db, config, logger: silent });

    // The job itself succeeded: there is nothing to retry about a corrupt file.
    expect(result.status).toBe('done');

    const asset = getById(db, mediaAssets, assetId);
    expect(asset?.ingestState).toBe('failed');
    expect(asset?.ingestError).toMatch(/could not open this file as a photo/i);
    expect(asset?.ingestError).not.toMatch(/error|exception|stack/i);
    expect(asset?.curationState).toBe('rejected');
    expect(asset?.deletedAt).toBeNull();
    expect(variantsOf(assetId)).toHaveLength(0);
  });

  it('does not let one bad file stop the good ones behind it', async () => {
    const bad = await upload('09-not-a-photo.jpg');
    const good = [await upload('01-portrait.jpg'), await upload('02-beach.jpg')];

    const results = await drain({ db, config, logger: silent });
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status === 'done')).toBe(true);
    expect(getById(db, mediaAssets, bad)?.ingestState).toBe('failed');
    for (const id of good) expect(getById(db, mediaAssets, id)?.ingestState).toBe('ready');
  });

  it('retries when the blob is not there yet, rather than losing the photo', async () => {
    const assetId = newId();
    insertOne(db, mediaAssets, {
      id: assetId,
      memorialId: memorial.id,
      mime: 'image/jpeg',
      byteSize: 1,
      blobKey: blobKeys.original(memorial.id, assetId, 'jpg'),
    });
    enqueue(db, {
      type: 'ingest-asset',
      memorialId: memorial.id,
      assetId,
      blobKey: blobKeys.original(memorial.id, assetId, 'jpg'),
    });

    const result = await runOnce({ db, config, logger: silent });
    expect(result.status).toBe('retrying');
    // Still processing, not written off: the retry may well find the file.
    expect(getById(db, mediaAssets, assetId)?.ingestState).toBe('processing');
  });

  it('shrugs at a photo the family removed while it sat in the queue', async () => {
    const assetId = await upload('01-portrait.jpg');
    db.update(mediaAssets)
      .set({ deletedAt: Date.now() })
      .where(eq(mediaAssets.id, assetId))
      .run();

    const result = await runOnce({ db, config, logger: silent });
    expect(result.status).toBe('done');
    if (result.status !== 'done') throw new Error('expected done');
    expect(result.result).toMatchObject({ state: 'skipped' });
    expect(variantsOf(assetId)).toHaveLength(0);
  });

  it('re-ingesting replaces the variants instead of doubling them', async () => {
    const assetId = await upload('01-portrait.jpg');
    await runOnce({ db, config, logger: silent });
    const key = blobKeys.original(memorial.id, assetId, 'jpg');
    enqueue(db, { type: 'ingest-asset', memorialId: memorial.id, assetId, blobKey: key });
    await runOnce({ db, config, logger: silent });

    expect(variantsOf(assetId)).toHaveLength(3);
  });
});

describe('video', () => {
  it('is kept as it arrived, and waits for a later phase', async () => {
    const assetId = newId();
    const key = blobKeys.original(memorial.id, assetId, 'mp4');
    await store.put(key, Buffer.from('not really a video, but it is stored'), 'video/mp4');
    insertOne(db, mediaAssets, {
      id: assetId,
      memorialId: memorial.id,
      mime: 'video/mp4',
      byteSize: 36,
      blobKey: key,
      originalFilename: 'clip.mp4',
    });
    enqueue(db, { type: 'ingest-asset', memorialId: memorial.id, assetId, blobKey: key });

    const result = await runOnce({ db, config, logger: silent });
    expect(result.status).toBe('done');
    const asset = getById(db, mediaAssets, assetId);
    expect(asset?.ingestState).toBe('ready');
    expect(asset?.curationState).toBe('pending');
    expect(variantsOf(assetId)).toHaveLength(0);
    expect(await store.exists(key)).toBe(true);
  });
});

describe('a whole batch, the way a family sends one', () => {
  it('processes the fixture set and leaves the grid in the right shape', async () => {
    const files = [
      '01-portrait.jpg',
      '02-beach.jpg',
      '03-wedding.jpg',
      '04-garden.jpg',
      '05-garden-near-duplicate.jpg',
      '06-blurry.jpg',
      '07-sideways.jpg',
      '08-phone.heic',
      '09-not-a-photo.jpg',
    ];
    for (const file of files) await upload(file);

    const results = await drain({ db, config, logger: silent, max: 50 });
    expect(results).toHaveLength(files.length);
    expect(results.every((r) => r.status === 'done')).toBe(true);

    const all = listWhere(db, mediaAssets, eq(mediaAssets.memorialId, memorial.id));
    expect(all).toHaveLength(9);
    expect(all.filter((a) => a.ingestState === 'ready')).toHaveLength(8);
    expect(all.filter((a) => a.ingestState === 'failed')).toHaveLength(1);
    expect(all.filter((a) => (a.blurScore ?? 1) < 0.25)).toHaveLength(1);

    const groups = new Set(all.map((a) => a.dupeGroupId).filter(Boolean));
    expect(groups.size).toBe(1);
    expect(all.filter((a) => a.dupeGroupId != null)).toHaveLength(2);

    const ready = listWhere(
      db,
      assetVariants,
      and(eq(assetVariants.kind, 'thumb320'), eq(assetVariants.mime, 'image/jpeg')),
    );
    expect(ready).toHaveLength(8);
  });
});
