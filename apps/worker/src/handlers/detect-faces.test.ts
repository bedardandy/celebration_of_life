/**
 * Face grouping, through the queue, with the deterministic engine.
 *
 * Everything goes through `runOnce` rather than calling the handler, because
 * the behaviours that matter are queue behaviours: a machine with no engine
 * must *skip* rather than fail, a second run must not duplicate anybody, and
 * removing the memorial must take every vector with it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assetVariants,
  createTestDb,
  eq,
  faceDetections,
  insertOne,
  listWhere,
  mediaAssets,
  memorials,
  newId,
  people,
  sql,
  type Db,
  type Memorial,
} from '@col/db';
import {
  dismissFaceCluster,
  listFaceClusters,
  nameFaceCluster,
  namedFaces,
  personCoverage,
  startFaceGrouping,
} from '@col/core';
import { MockFaceEngine } from '@col/media';
import { LocalDiskStore } from '@col/storage';
import { setFaceEngine, setFacesBlobStore } from './index';
import { drain } from '../runner';
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
  workerId: 'faces-test',
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
    decedentKnownAs: 'Ruth',
    birthYear: 1938,
    deathYear: 2026,
  });
  workdir = mkdtempSync(path.join(tmpdir(), 'col-faces-'));
  store = new LocalDiskStore(workdir);
  setFacesBlobStore(store);
  setFaceEngine(new MockFaceEngine());
});

afterEach(() => {
  setFacesBlobStore(undefined);
  setFaceEngine(undefined);
  db.$sqlite.close();
  rmSync(workdir, { recursive: true, force: true });
});

/**
 * A photograph as it looks after ingest: real bytes on disk, a review-size
 * variant, and the filename the family sent — which is what the deterministic
 * engine reads a person out of.
 */
async function photo(
  filename: string,
  options: { fixture?: string; capturedAt?: number; era?: string } = {},
): Promise<string> {
  const assetId = newId();
  const bytes = await readFile(path.join(FIXTURES, options.fixture ?? '01-portrait.jpg'));
  const key = `memorial/${memorial.id}/original/${assetId}.jpg`;
  await store.put(key, bytes, 'image/jpeg');

  insertOne(db, mediaAssets, {
    id: assetId,
    memorialId: memorial.id,
    originalFilename: filename,
    mime: 'image/jpeg',
    byteSize: bytes.byteLength,
    blobKey: key,
    ingestState: 'ready',
    curationState: 'approved',
    ...(options.capturedAt ? { capturedAt: options.capturedAt } : {}),
    ...(options.era ? { eraGuess: options.era } : {}),
  });
  insertOne(db, assetVariants, {
    assetId,
    kind: 'web1600',
    blobKey: key,
    mime: 'image/jpeg',
    byteSize: bytes.byteLength,
  });
  return assetId;
}

const run = () => drain({ db, config, logger: silent });

/* -------------------------------------------------------------------------- */

describe('detect-faces', () => {
  it('groups the same person across the decades and keeps a stranger apart', async () => {
    await photo('ruth-1962.jpg', { era: '1960s' });
    await photo('ruth-1975.jpg', { era: '1970s' });
    await photo('ruth-1988.jpg', { era: '1980s' });
    await photo('harold-1980.jpg', { era: '1980s' });
    await photo('noface-house.jpg');

    startFaceGrouping(db, memorial.id);
    const [result] = await run();

    expect(result?.status).toBe('done');
    const outcome = result?.status === 'done' ? (result.result as Record<string, unknown>) : {};
    expect(outcome['engine']).toBe('mock');
    expect(outcome['scanned']).toBe(5);
    expect(outcome['faces']).toBe(4);

    const clusters = listFaceClusters(db, memorial.id);
    expect(clusters[0]?.photoCount).toBe(3);
    expect(clusters[0]?.samples.length).toBeGreaterThan(0);
    // Harold is on his own, which is a group of one and not a suggestion.
    expect(clusters.map((c) => c.photoCount)).toEqual([3, 1]);

    // The house with nobody in it recorded nothing at all.
    expect(listWhere(db, faceDetections, eq(faceDetections.memorialId, memorial.id))).toHaveLength(
      4,
    );
  });

  it('records the consent moment on the memorial when the button is pressed', async () => {
    await photo('ruth-1962.jpg');
    expect(memorial.faceGroupingStartedAt).toBeNull();

    startFaceGrouping(db, memorial.id);
    const after = listWhere(db, memorials, eq(memorials.id, memorial.id))[0];
    expect(after?.faceGroupingStartedAt).toBeGreaterThan(0);
  });

  it('skips rather than fails when there is no engine on this machine', async () => {
    await photo('ruth-1962.jpg');
    setFaceEngine(undefined);
    // No engine resolved from the environment either.
    const previous = process.env['FACE_ENGINE'];
    process.env['FACE_ENGINE'] = 'off';

    startFaceGrouping(db, memorial.id);
    const [result] = await run();

    process.env['FACE_ENGINE'] = previous;

    expect(result?.status).toBe('done');
    const outcome = result?.status === 'done' ? (result.result as Record<string, unknown>) : {};
    expect(outcome['status']).toBe('skipped');
    expect(String(outcome['reason'])).toMatch(/FACE_ENGINE/);
    expect(listWhere(db, faceDetections, eq(faceDetections.memorialId, memorial.id))).toHaveLength(
      0,
    );
  });

  it('leaves a name in place when new photographs arrive and grouping runs again', async () => {
    await photo('ruth-1962.jpg', { era: '1960s' });
    await photo('ruth-1975.jpg', { era: '1970s' });
    startFaceGrouping(db, memorial.id);
    await run();

    const cluster = listFaceClusters(db, memorial.id)[0];
    const named = nameFaceCluster(db, {
      memorialId: memorial.id,
      clusterId: cluster?.clusterId as string,
      name: 'Ruth',
    });
    expect(named?.faces).toBe(2);

    // A cousin sends another photograph of the same person a day later.
    await photo('ruth-1994.jpg', { era: '1990s' });
    startFaceGrouping(db, memorial.id);
    await run();

    const chips = namedFaces(db, memorial.id);
    expect(chips).toHaveLength(1);
    expect(chips[0]?.name).toBe('Ruth');
    expect(chips[0]?.photoCount).toBe(3);
    // One person row, not one per pass.
    expect(listWhere(db, people, eq(people.memorialId, memorial.id))).toHaveLength(1);
  });

  it('marks the person who died, so the coverage nudge can talk about their thirties', async () => {
    await photo('ruth-1962.jpg', { era: '1960s' });
    await photo('ruth-1988.jpg', { era: '1980s' });
    startFaceGrouping(db, memorial.id);
    await run();

    const cluster = listFaceClusters(db, memorial.id)[0];
    nameFaceCluster(db, {
      memorialId: memorial.id,
      clusterId: cluster?.clusterId as string,
      name: 'Ruth',
    });

    const face = namedFaces(db, memorial.id)[0];
    expect(face?.isDecedent).toBe(true);

    const coverage = personCoverage(db, memorial, face!);
    expect(coverage.gap?.message).toMatch(/No photos of Ruth/);
    // Born 1938: the 1970s are her thirties.
    expect(coverage.gap?.era).toBe('1970s');
    expect(coverage.gap?.message).toMatch(/thirties/);
  });

  it('stops asking about a group the family says is not one person', async () => {
    await photo('ruth-1962.jpg');
    await photo('ruth-1975.jpg');
    startFaceGrouping(db, memorial.id);
    await run();

    const cluster = listFaceClusters(db, memorial.id)[0];
    expect(dismissFaceCluster(db, memorial.id, cluster?.clusterId as string)).toBe(2);
    expect(listFaceClusters(db, memorial.id)).toHaveLength(0);

    // And running it again does not resurrect the suggestion.
    startFaceGrouping(db, memorial.id);
    await run();
    expect(listFaceClusters(db, memorial.id)).toHaveLength(0);
  });

  it('takes every face vector with the memorial when it is really deleted', async () => {
    await photo('ruth-1962.jpg');
    await photo('harold-1980.jpg');
    startFaceGrouping(db, memorial.id);
    await run();
    expect(
      listWhere(db, faceDetections, eq(faceDetections.memorialId, memorial.id)).length,
    ).toBeGreaterThan(0);

    // The purge is a real delete of the memorial row; the cascade is the
    // promise. Foreign keys are on for this check because that is how the
    // application runs.
    db.$sqlite.exec('PRAGMA foreign_keys = ON');
    db.delete(memorials).where(eq(memorials.id, memorial.id)).run();

    expect(listWhere(db, faceDetections, sql`1 = 1`)).toHaveLength(0);
    expect(listWhere(db, mediaAssets, sql`1 = 1`)).toHaveLength(0);
  });
});
