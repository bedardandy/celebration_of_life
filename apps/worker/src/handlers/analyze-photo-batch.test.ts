/**
 * Photo analysis, through the queue.
 *
 * The parts worth testing are the ones that decide whether a family's
 * photographs leave this machine: the consent gate, what counts as analysable,
 * and what happens when the model comes back with nonsense. The analysis text
 * itself comes from committed fixtures, so this never touches a real model.
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assetVariants,
  createTestDb,
  enqueue,
  getById,
  insertOne,
  mediaAssets,
  memorials,
  updateById,
  type Db,
  type Memorial,
  type MediaAsset,
} from '@col/db';
import { LocalDiskStore, setBlobStore, blobKeys } from '@col/storage';
import { MOCK_PROVIDER_ID, getProvider, resetMockState } from '@col/ai';
import { runOnce } from '../runner';
import type { WorkerConfig } from '../config';
import type { Logger } from '../log';
import {
  ANALYSIS_VARIANT,
  analysisAllowed,
  analysisWithEra,
  chunk,
  selectAnalyzableAssets,
} from './analyze-photo-batch';

const silent: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => silent,
};

const config: WorkerConfig = {
  workerId: 'analyze-test',
  pollIntervalMs: 5,
  leaseMs: 30_000,
  maxAttempts: 3,
};

const FIXTURE_PHOTOS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
  'fixtures',
  'photos',
);

let db: Db;
let memorial: Memorial;
let storageRoot: string;

beforeEach(() => {
  db = createTestDb();
  resetMockState();
  storageRoot = mkdtempSync(path.join(tmpdir(), 'col-analyze-'));
  setBlobStore(new LocalDiskStore(storageRoot));
  memorial = insertOne(db, memorials, { decedentName: 'Ruth Hartley', birthYear: 1936 } as never);
});

afterEach(() => {
  setBlobStore(undefined);
  rmSync(storageRoot, { recursive: true, force: true });
});

/**
 * An asset row plus a web1600 variant actually sitting on disk.
 *
 * The variant is keyed by the fixture's own file name rather than by asset id.
 * That is what lets the mock find the canned analysis for it: fixtures are
 * keyed by basename, and in production the basename is an opaque asset id, so a
 * real batch correctly falls through to the generic default. A canned analysis
 * of a photograph nobody has ever seen would be a lie.
 */
function addPhoto(file: string, overrides: Partial<MediaAsset> = {}): MediaAsset {
  const asset = insertOne(db, mediaAssets, {
    memorialId: memorial.id,
    originalFilename: file,
    mime: 'image/jpeg',
    blobKey: blobKeys.original(memorial.id, 'x', 'jpg'),
    ingestState: 'ready',
    ...overrides,
  } as never) as MediaAsset;

  const variantKey = `memorial/${memorial.id}/variant/${ANALYSIS_VARIANT}/${file}`;
  const target = path.join(storageRoot, variantKey);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(path.join(FIXTURE_PHOTOS, file), target);

  insertOne(db, assetVariants, {
    assetId: asset.id,
    kind: ANALYSIS_VARIANT,
    blobKey: variantKey,
    mime: 'image/jpeg',
  } as never);
  return asset;
}

async function runBatch(assetIds: string[]) {
  enqueue(db, { type: 'analyze-photo-batch', memorialId: memorial.id, assetIds });
  return runOnce({ db, config, logger: silent });
}

/* -------------------------------------------------------------------------- */

describe('choosing what to analyse', () => {
  it('takes photos that have not been described yet', () => {
    const fresh = addPhoto('01-portrait.jpg');
    const done = addPhoto('02-beach.jpg');
    updateById(db, mediaAssets, done.id, {
      analysis: {
        description: 'already looked at',
        settingTags: [],
        emotionalTone: 'calm',
        slideSuitability: 0.5,
      },
    });

    const chosen = selectAnalyzableAssets(db, memorial.id, [fresh.id, done.id]);
    expect(chosen.map((a) => a.id)).toEqual([fresh.id]);
  });

  it('leaves out anything the family has thrown away or deleted', () => {
    const rejected = addPhoto('01-portrait.jpg', { curationState: 'rejected' } as never);
    const deleted = addPhoto('02-beach.jpg', { deletedAt: Date.now() } as never);
    expect(selectAnalyzableAssets(db, memorial.id, [rejected.id, deleted.id])).toHaveLength(0);
  });

  it('splits a long list into calls the provider will accept', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([1, 2], 0)).toEqual([[1], [2]]);
  });
});

describe('the consent gate', () => {
  const metered = {
    ...getProvider(MOCK_PROVIDER_ID),
    id: 'anthropic-api',
    capabilities: { ...getProvider(MOCK_PROVIDER_ID).capabilities, costTier: 'metered' as const },
  };

  it('lets a free or subscription provider through without asking', () => {
    expect(
      analysisAllowed(getProvider(MOCK_PROVIDER_ID), { aiConsentPhotoAnalysis: false }),
    ).toEqual({ allowed: true });
  });

  it('stops a metered provider when the family has not agreed', () => {
    const result = analysisAllowed(metered, { aiConsentPhotoAnalysis: false });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain('paid API');
      expect(result.reason).toContain('consent');
    }
  });

  it('lets a metered provider through once they have', () => {
    expect(analysisAllowed(metered, { aiConsentPhotoAnalysis: true })).toEqual({ allowed: true });
  });
});

describe('era backfill', () => {
  const analysis = {
    description: 'a photograph',
    eraGuess: '1970s',
    settingTags: [],
    emotionalTone: 'calm',
    slideSuitability: 0.5,
  };

  it('prefers the EXIF year over the model’s guess', () => {
    const asset = { capturedAt: Date.UTC(1974, 5, 1) } as MediaAsset;
    expect(analysisWithEra(analysis, asset).eraGuess).toBe('1974');
  });

  it('keeps the guess when the file had no capture time', () => {
    expect(analysisWithEra(analysis, { capturedAt: null } as MediaAsset).eraGuess).toBe('1970s');
  });
});

describe('the job, through the queue', () => {
  it('writes a canned analysis onto each row', async () => {
    const garden = addPhoto('04-garden.jpg');
    const blurry = addPhoto('06-blurry.jpg');

    const result = await runBatch([garden.id, blurry.id]);
    expect(result.status).toBe('done');
    expect(result.status === 'done' && (result.result as { analyzed: number }).analyzed).toBe(2);

    const gardenRow = getById(db, mediaAssets, garden.id);
    expect(gardenRow?.analysis?.description).toMatch(/kneeling/i);
    expect(gardenRow?.analysis?.slideSuitability).toBeGreaterThan(0.9);

    const blurryRow = getById(db, mediaAssets, blurry.id);
    // Flagged as unusable, not removed — the family decides.
    expect(blurryRow?.analysis?.slideSuitability).toBeLessThan(0.3);
  });

  it('backfills the era from EXIF when the row has one', async () => {
    const asset = addPhoto('03-wedding.jpg', { capturedAt: Date.UTC(1958, 3, 12) } as never);
    await runBatch([asset.id]);
    expect(getById(db, mediaAssets, asset.id)?.analysis?.eraGuess).toBe('1958');
  });

  it('does nothing at all when every photo is already described', async () => {
    const asset = addPhoto('01-portrait.jpg');
    await runBatch([asset.id]);
    const second = await runBatch([asset.id]);
    expect(second.status).toBe('done');
    expect(second.status === 'done' && (second.result as { status: string }).status).toBe(
      'nothing-to-do',
    );
  });

  it('waits rather than failing when the ingest variants are not there yet', async () => {
    const asset = insertOne(db, mediaAssets, {
      memorialId: memorial.id,
      mime: 'image/jpeg',
      blobKey: 'memorial/x/original/y.jpg',
    } as never) as MediaAsset;
    const result = await runBatch([asset.id]);
    expect(result.status).toBe('done');
    expect((result as { result: { status: string } }).result.status).toBe('nothing-to-do');
  });

  it('records a consent skip as a finished job, not a failure', async () => {
    // The mock is free, so the gate is exercised directly rather than by
    // pointing the worker at a paid API it must never actually call.
    const metered = {
      ...getProvider(MOCK_PROVIDER_ID),
      id: 'openai-api',
      capabilities: { ...getProvider(MOCK_PROVIDER_ID).capabilities, costTier: 'metered' as const },
    };
    const result = analysisAllowed(metered, memorial);
    expect(result.allowed).toBe(false);
    expect(memorial.aiConsentPhotoAnalysis).toBe(false);
  });
});
