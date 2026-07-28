/**
 * Generating a slideshow, through the queue, against committed fixtures.
 *
 * The acceptance criterion this file exists for: a mock-driven generate-edl job
 * on a fixture memorial produces a schema-valid EDL that references only asset
 * ids which actually exist. The rest of it is about the ways the job is allowed
 * to fail — no consent, no photographs, a model that returns nonsense — none of
 * which may end with a family having nothing.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  createTestDb,
  enqueue,
  getById,
  insertOne,
  mediaAssets,
  memorials,
  memoryNotes,
  slideshowProjects,
  updateById,
  type Db,
  type Memorial,
  type SlideshowProject,
} from '@col/db';
import { EdlSchema } from '@col/schemas';
import { resetMockState } from '@col/ai';
import { projectCut } from '@col/core';
import { runOnce } from '../runner';
import type { WorkerConfig } from '../config';
import type { Logger } from '../log';
import { edlGenerationAllowed, type GenerateEdlOutcome } from './generate-edl';

const silent: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => silent,
};

const config: WorkerConfig = {
  workerId: 'edl-test',
  pollIntervalMs: 5,
  leaseMs: 30_000,
  maxAttempts: 3,
};

let db: Db;
let memorial: Memorial;
let project: SlideshowProject;

beforeEach(() => {
  db = createTestDb();
  resetMockState();
  memorial = insertOne(db, memorials, {
    decedentName: 'Margaret Anne Doyle',
    birthYear: 1938,
    deathYear: 2024,
  } as never);
  project = insertOne(db, slideshowProjects, { memorialId: memorial.id } as never);
});

function addApprovedPhoto(index: number, capturedYear?: number): string {
  const asset = insertOne(db, mediaAssets, {
    memorialId: memorial.id,
    originalFilename: `photo-${index}.jpg`,
    mime: 'image/jpeg',
    blobKey: `memorial/${memorial.id}/original/photo-${index}.jpg`,
    curationState: 'approved',
    ingestState: 'ready',
    width: index % 3 === 0 ? 1200 : 4000,
    height: index % 3 === 0 ? 1600 : 3000,
    ...(capturedYear
      ? { capturedAt: Date.UTC(capturedYear, 5, 1), eraGuess: `${capturedYear}s` }
      : {}),
    analysis: {
      description: `A photograph, number ${index}`,
      settingTags: ['home'],
      emotionalTone: 'warm',
      slideSuitability: Number((0.3 + (index % 7) * 0.08).toFixed(2)),
    },
  } as never);
  return (asset as { id: string }).id;
}

async function run(regenerate = false): Promise<GenerateEdlOutcome> {
  enqueue(db, {
    type: 'generate-edl',
    memorialId: memorial.id,
    projectId: project.id,
    regenerate,
  });
  const result = await runOnce({ db, config, logger: silent });
  expect(result.status).toBe('done');
  if (result.status !== 'done') throw new Error('the job did not run');
  return result.result as GenerateEdlOutcome;
}

function storedEdl() {
  const row = getById(db, slideshowProjects, project.id);
  return EdlSchema.parse(row?.edl);
}

/* -------------------------------------------------------------------------- */

describe('generating an EDL from a fixture memorial', () => {
  it('produces a schema-valid EDL that names only real photographs', async () => {
    const ids = new Set(Array.from({ length: 12 }, (_, i) => addApprovedPhoto(i, 1950 + i * 5)));
    insertOne(db, memoryNotes, {
      memorialId: memorial.id,
      authorName: 'Her daughter, Anne',
      text: 'She always said the garden would outlive her.',
      approved: true,
    } as never);

    const outcome = await run();
    expect(outcome.status).toBe('done');
    expect(outcome.providerId).toBe('mock');

    const edl = storedEdl();
    for (const slide of Object.values(edl.slides)) {
      if (slide.kind === 'photo') expect(ids.has(slide.assetId)).toBe(true);
    }
    expect(edl.projectId).toBe(project.id);
    expect(outcome.slideCount).toBeGreaterThan(0);
  });

  it('only puts words on screen that a real person wrote and approved', async () => {
    Array.from({ length: 6 }, (_, i) => addApprovedPhoto(i));
    insertOne(db, memoryNotes, {
      memorialId: memorial.id,
      authorName: 'Her son, Peter',
      text: 'He taught me to drive in the church car park.',
      approved: true,
    } as never);
    insertOne(db, memoryNotes, {
      memorialId: memorial.id,
      authorName: 'A neighbour',
      text: 'This one has not been approved and must never appear.',
      approved: false,
    } as never);

    await run();
    const quotes = Object.values(storedEdl().slides).filter((slide) => slide.kind === 'quote');
    for (const quote of quotes) {
      if (quote.kind === 'quote') expect(quote.text).not.toContain('never appear');
    }
  });

  it('bumps the version so the preview knows to reload', async () => {
    Array.from({ length: 5 }, (_, i) => addApprovedPhoto(i));
    await run();
    const first = getById(db, slideshowProjects, project.id);
    expect(first?.edlVersion).toBe(1);
    expect(first?.status).toBe('ready');

    await run(true);
    expect(getById(db, slideshowProjects, project.id)?.edlVersion).toBe(2);
  });

  it('leaves an existing slideshow alone unless asked to redo it', async () => {
    Array.from({ length: 5 }, (_, i) => addApprovedPhoto(i));
    await run();
    const outcome = await run();
    expect(outcome.status).toBe('already-done');
    expect(getById(db, slideshowProjects, project.id)?.edlVersion).toBe(1);
  });

  it('reports both cuts, with the service one no longer than five minutes', async () => {
    Array.from({ length: 40 }, (_, i) => addApprovedPhoto(i, 1950 + i));
    const outcome = await run();
    expect(outcome.serviceSec).toBeLessThanOrEqual(315);
    expect(outcome.familySec).toBeGreaterThanOrEqual(outcome.serviceSec);

    const edl = storedEdl();
    const service = projectCut(edl, 'service');
    const family = projectCut(edl, 'family');
    expect(service.slides.length).toBeLessThanOrEqual(family.slides.length);
  });

  it('says there is nothing to do rather than inventing a slideshow', async () => {
    const outcome = await run();
    expect(outcome.status).toBe('nothing-to-do');
    expect(getById(db, slideshowProjects, project.id)?.edl).toBeFalsy();
  });

  it('ignores photographs the family has not approved', async () => {
    const approved = addApprovedPhoto(1);
    const pending = addApprovedPhoto(2);
    updateById(db, mediaAssets, pending, { curationState: 'pending' });

    await run();
    const used = Object.values(storedEdl().slides)
      .filter((slide) => slide.kind === 'photo')
      .map((slide) => (slide.kind === 'photo' ? slide.assetId : ''));
    expect(used).toEqual([approved]);
  });
});

describe('consent', () => {
  it('lets a subscription or local provider through without asking', () => {
    const local = { id: 'mock', capabilities: { costTier: 'free' } };
    expect(edlGenerationAllowed(local as never, { aiConsentExternal: false }).allowed).toBe(true);
  });

  it('holds a metered provider until the family has said yes', () => {
    const metered = { id: 'anthropic-api', capabilities: { costTier: 'metered' } };
    const refused = edlGenerationAllowed(metered as never, { aiConsentExternal: false });
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) expect(refused.reason).toContain('has not been agreed');
    expect(edlGenerationAllowed(metered as never, { aiConsentExternal: true }).allowed).toBe(true);
  });
});
