/**
 * The render, proved rather than asserted.
 *
 * "It wouldn't play at the funeral" is the catastrophic failure of this entire
 * product, and it is almost never something a preview would have shown you: it
 * is a pixel format, a missing audio track, an index at the wrong end of the
 * file. So this test renders a real — very small — video through the real
 * handler, with real music, and then asks ffprobe and ffmpeg what actually came
 * out:
 *
 *  - H.264, yuv420p, MP4, moov before mdat, and the length the timeline says;
 *  - an AAC track in both modes, silent in the side-loaded one;
 *  - loudness within a decibel and a half of −16 LUFS, measured on the
 *    delivered file rather than on the music that went into it.
 *
 * Three slides at 640×360 keeps it to a few seconds of video, because this is a
 * format check, not a quality check. If ffmpeg or a browser is unavailable the
 * test says so loudly and skips: a machine that cannot render must not report
 * a passing render, and must not fail a build for the network's sake.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EdlSchema, type Edl } from '@col/schemas';
import {
  assetVariants,
  createTestDb,
  eq,
  getById,
  insertOne,
  jobs,
  mediaAssets,
  memorials,
  musicTracks,
  renderJobs,
  slideshowProjects,
  updateById,
  type Db,
  type Memorial,
  type RenderJob,
  type SlideshowProject,
} from '@col/db';
import { chooseClearedTrack, chooseSideloaded, projectCut, requestRender } from '@col/core';
import { encodeWav, isFaststart, measureLoudness, runFfmpeg } from '@col/media';
import { LocalDiskStore, blobKeys } from '@col/storage';
import { findBrowser } from '@col/video/browser';
import { setRenderBlobStore } from './index';
import { runOnce } from '../runner';
import type { WorkerConfig } from '../config';
import type { Logger } from '../log';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PHOTOS = path.resolve(here, '../../../..', 'fixtures/photos');

const silent: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => silent,
};

const config: WorkerConfig = {
  workerId: 'render-test',
  pollIntervalMs: 5,
  leaseMs: 120_000,
  maxAttempts: 1,
};

/* -------------------------------------------------------------------------- */
/* can this machine render at all?                                             */
/* -------------------------------------------------------------------------- */

function has(binary: string): boolean {
  try {
    execFileSync(binary, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const ffmpegReady = has('ffmpeg') && has('ffprobe');
const browser = findBrowser();
const canRender = ffmpegReady && browser !== undefined;

if (!canRender) {
  process.emitWarning(
    `[render] SKIPPED — ${!ffmpegReady ? 'ffmpeg/ffprobe are not on PATH' : 'no Chromium was found'}. ` +
      'The render pipeline was NOT verified on this machine.',
  );
}

/* -------------------------------------------------------------------------- */
/* the fixture slideshow                                                       */
/* -------------------------------------------------------------------------- */

const crossfade = { kind: 'crossfade' as const, durationSec: 0.5 };

function fixtureEdl(projectId: string, assetId: string): Edl {
  return EdlSchema.parse({
    version: 1,
    projectId,
    fps: 30,
    resolution: { w: 1920, h: 1080 },
    audio: { mode: 'sideloaded', startOffsetSec: 0 },
    theme: { id: 'quiet-linen' },
    chapters: [
      { id: 'opening', title: 'Opening', slideIds: ['title'] },
      { id: 'life', title: 'A life', slideIds: ['photo'] },
      { id: 'closing', title: 'Closing', slideIds: ['closing'] },
    ],
    slides: {
      title: {
        kind: 'title',
        text: 'Ruth Kelleher',
        subtext: '1938 — 2024',
        durationSec: 4,
        transitionOut: crossfade,
      },
      photo: {
        kind: 'photo',
        assetId,
        variant: 'render2400',
        durationSec: 3,
        kenBurns: {
          from: { x: 0, y: 0, w: 1, h: 1 },
          to: { x: 0.05, y: 0.04, w: 0.9, h: 0.9 },
          easing: 'easeInOut',
        },
        caption: { text: 'The garden she kept', position: 'lower-third' },
        transitionOut: crossfade,
        suitability: 0.8,
        sourceAspect: 1.33,
      },
      closing: { kind: 'closing', line1: 'Ruth Kelleher', line2: '1938 — 2024', durationSec: 6 },
    },
    cuts: { service: { targetSec: 300 } },
    omittedSlideIds: [],
  });
}

/**
 * Ten seconds of quiet test tone, written as raw PCM and encoded like a
 * library track. Not music — a known, deliberately quiet signal, so the
 * loudness assertion is measuring the normalisation rather than a coincidence.
 */
async function makeTestTone(file: string): Promise<number> {
  const sampleRate = 44_100;
  const seconds = 10;
  const frames = sampleRate * seconds;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    const t = i / sampleRate;
    // A third of full scale: the loudnorm pass has to lift it, and a test that
    // starts at the target proves nothing.
    const value = 0.3 * Math.sin(2 * Math.PI * 220 * t) + 0.12 * Math.sin(2 * Math.PI * 330 * t);
    left[i] = value;
    right[i] = value * 0.98;
  }
  const wav = path.join(path.dirname(file), 'tone.wav');
  await writeFile(wav, encodeWav([left, right], { sampleRate, channels: 2 }));
  await runFfmpeg([
    '-hide_banner',
    '-nostdin',
    '-y',
    '-i',
    wav,
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    '-movflags',
    '+faststart',
    file,
  ]);
  return seconds;
}

/* -------------------------------------------------------------------------- */

let workdir: string;
let store: LocalDiskStore;
let db: Db;
let memorial: Memorial;
let project: SlideshowProject;
let toneSec = 0;

beforeAll(async () => {
  workdir = mkdtempSync(path.join(tmpdir(), 'col-render-test-'));
  store = new LocalDiskStore(path.join(workdir, 'blobs'));
  setRenderBlobStore(store);

  db = createTestDb();
  memorial = insertOne(db, memorials, {
    decedentName: 'Ruth Kelleher',
    birthYear: 1938,
    deathYear: 2024,
    traditionSlug: 'secular',
  } as never);

  project = insertOne(db, slideshowProjects, {
    memorialId: memorial.id,
    audioMode: 'sideloaded',
    status: 'ready',
  } as never);

  // One real photograph, with a render2400 variant in the blob store — the
  // renderer must fetch it over HTTP exactly as it will in production.
  const asset = insertOne(db, mediaAssets, {
    memorialId: memorial.id,
    mime: 'image/jpeg',
    blobKey: blobKeys.original(memorial.id, 'photo-1', 'jpg'),
    curationState: 'approved',
    ingestState: 'ready',
    width: 640,
    height: 480,
  } as never);

  if (ffmpegReady) {
    const bytes = await readFile(path.join(FIXTURE_PHOTOS, '01-portrait.jpg'));
    const key = blobKeys.variant(memorial.id, asset.id, 'render2400', 'jpg');
    await store.put(key, bytes, 'image/jpeg');
    insertOne(db, assetVariants, {
      assetId: asset.id,
      kind: 'render2400',
      blobKey: key,
      mime: 'image/jpeg',
      width: 640,
      height: 480,
      byteSize: bytes.byteLength,
    } as never);

    const toneFile = path.join(workdir, 'tone.m4a');
    toneSec = await makeTestTone(toneFile);
    const trackKey = 'library/music/test-tone/audio.m4a';
    await store.put(trackKey, await readFile(toneFile), 'audio/mp4');
    insertOne(db, musicTracks, {
      slug: 'test-tone',
      title: 'Test Tone',
      licenseKind: 'public-domain',
      licenseNote: 'Synthesised in this test.',
      blobKey: trackKey,
      durationSec: toneSec,
      bpm: 72,
      moodTags: ['peaceful'],
    } as never);
  }

  // Written straight onto the row: this test is about the renderer, so the EDL
  // must not move if the generator changes its mind about four photographs.
  updateById(db, slideshowProjects, project.id, {
    edl: fixtureEdl(project.id, asset.id),
    edlVersion: 1,
  });
}, 180_000);

afterAll(() => {
  setRenderBlobStore(undefined);
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

/** Run the queued render job through the real worker runner. */
async function runQueuedRender(renderJob: RenderJob): Promise<RenderJob> {
  const result = await runOnce({ db, config, logger: silent });
  if (result.status !== 'done') {
    throw new Error(
      `render job did not finish: ${result.status}${'error' in result ? ` — ${result.error}` : ''}`,
    );
  }
  const row = getById(db, renderJobs, renderJob.id);
  if (!row) throw new Error('the render job row vanished');
  return row;
}

async function outputFile(row: RenderJob): Promise<string> {
  if (!row.outputBlobKey) throw new Error('the render produced no output');
  return store.getPath(row.outputBlobKey);
}

/* -------------------------------------------------------------------------- */

describe.skipIf(!canRender)('the render pipeline', () => {
  it('renders a cleared-music video a funeral laptop can play, at −16 LUFS', async () => {
    const track = db.select().from(musicTracks).all()[0];
    if (!track) throw new Error('no test track');
    chooseClearedTrack(db, {
      memorialId: memorial.id,
      projectId: project.id,
      trackId: track.id,
    });

    const { renderJob } = requestRender(db, {
      memorialId: memorial.id,
      projectId: project.id,
      cut: 'family',
      preset: 'draft360',
    });

    const done = await runQueuedRender(renderJob);
    expect(done.status).toBe('done');
    expect(done.progress).toBe(1);

    const file = await outputFile(done);
    const probe = done.ffprobeMeta as Record<string, unknown>;

    expect(probe['videoCodec']).toBe('h264');
    expect(probe['pixelFormat']).toBe('yuv420p');
    expect(probe['audioCodec']).toBe('aac');
    expect(probe['faststart']).toBe(true);
    expect([probe['width'], probe['height']]).toEqual([640, 360]);
    expect(String(probe['formatName'])).toContain('mp4');

    // The index really is at the front of the file, checked from the bytes.
    expect(await isFaststart(file)).toBe(true);

    const edl = getById(db, slideshowProjects, project.id)?.edl as Edl;
    const timeline = projectCut(edl, 'family');
    expect(Math.abs((done.durationSec ?? 0) - timeline.totalSec)).toBeLessThanOrEqual(0.5);

    // The whole point of the two-pass loudnorm: measured on what a family
    // downloads, not on what went into it.
    const loudness = await measureLoudness(file);
    expect(loudness, 'the delivered file must have measurable loudness').toBeDefined();
    expect(Math.abs((loudness?.input_i ?? -99) - -16)).toBeLessThanOrEqual(1.5);

    // The music was ten seconds and the video is longer, so it had to loop —
    // and looping must not have changed the length of the video.
    expect(timeline.totalSec).toBeGreaterThan(toneSec);
  }, 600_000);

  it('renders a side-loaded video that is silent but still carries an audio track', async () => {
    chooseSideloaded(db, {
      memorialId: memorial.id,
      projectId: project.id,
      title: 'Danny Boy',
      artist: 'Her brother, on the fiddle',
      bpm: 68,
    });

    const { renderJob } = requestRender(db, {
      memorialId: memorial.id,
      projectId: project.id,
      cut: 'service',
      preset: 'draft360',
    });

    const done = await runQueuedRender(renderJob);
    expect(done.status).toBe('done');

    const probe = done.ffprobeMeta as Record<string, unknown>;
    expect(probe['videoCodec']).toBe('h264');
    // A real, silent AAC stream: several venue players refuse a file with no
    // audio track at all, which is the failure this guards against.
    expect(probe['audioCodec']).toBe('aac');

    const file = await outputFile(done);
    const loudness = await measureLoudness(file);
    // Digital silence measures at the floor, wherever ffmpeg puts that.
    expect(loudness?.input_i ?? -99).toBeLessThan(-60);
  }, 600_000);

  it('reuses a render that is already queued rather than starting a second', () => {
    const first = requestRender(db, {
      memorialId: memorial.id,
      projectId: project.id,
      cut: 'family',
      preset: 'backup720',
    });
    const second = requestRender(db, {
      memorialId: memorial.id,
      projectId: project.id,
      cut: 'family',
      preset: 'backup720',
    });
    expect(second.reused).toBe(true);
    expect(second.renderJob.id).toBe(first.renderJob.id);

    // Leave the queue as we found it, so a later test is not surprised by it.
    db.delete(renderJobs).where(eq(renderJobs.id, first.renderJob.id)).run();
  });
});

describe('when a render cannot be made', () => {
  /**
   * Earlier tests leave queued work behind on purpose (a render nobody ran is
   * a real state). These two are about what the *next* run does, so they start
   * from an empty queue rather than claiming somebody else's job.
   */
  beforeEach(() => {
    db.delete(jobs).run();
  });

  it('marks the row failed, keeps the reason, and lets the queue give up', async () => {
    // A project with no EDL at all: nothing to render, and nothing a retry
    // would fix — but the family must still be told something true.
    const empty = insertOne(db, slideshowProjects, {
      memorialId: memorial.id,
      status: 'draft',
    } as never);
    const { renderJob } = requestRender(db, {
      memorialId: memorial.id,
      projectId: empty.id,
      cut: 'family',
      preset: 'draft360',
    });

    // One attempt only: this is the last word, and the row must say so.
    updateById(db, jobs, renderJob.jobId as string, { maxAttempts: 1 });

    const result = await runOnce({ db, config, logger: silent });
    expect(result.status).toBe('failed');

    const row = getById(db, renderJobs, renderJob.id);
    expect(row?.status).toBe('failed');
    expect(row?.error).toContain('no EDL');
    expect(row?.finishedAt).toBeTruthy();

    db.delete(renderJobs).where(eq(renderJobs.id, renderJob.id)).run();
  });

  it('leaves the row queued for another attempt while attempts remain', async () => {
    const empty = insertOne(db, slideshowProjects, {
      memorialId: memorial.id,
      status: 'draft',
    } as never);
    const { renderJob } = requestRender(db, {
      memorialId: memorial.id,
      projectId: empty.id,
      cut: 'family',
      preset: 'draft360',
    });

    // Three attempts, as `requestRender` queues in production: a first failure
    // is not the last word.
    const result = await runOnce({ db, config, logger: silent });
    expect(result.status).toBe('retrying');

    const row = getById(db, renderJobs, renderJob.id);
    expect(row?.status).toBe('queued');
    expect(row?.error).toContain('no EDL');
    // Backoff is the queue's business; the row only says it will come round again.
    expect(row?.finishedAt).toBeFalsy();

    db.delete(renderJobs).where(eq(renderJobs.id, renderJob.id)).run();
  });
});

describe('the render job row', () => {
  it('records a queued job and points it at the queue entry', () => {
    const { renderJob } = requestRender(db, {
      memorialId: memorial.id,
      projectId: project.id,
      cut: 'family',
      preset: 'final1080',
    });
    expect(renderJob.status).toBe('queued');
    expect(renderJob.jobId).toBeTruthy();

    const queued = db.select().from(renderJobs).all();
    expect(queued.some((row) => row.preset === 'final1080')).toBe(true);

    db.delete(renderJobs).where(eq(renderJobs.id, renderJob.id)).run();
  });

  it('refuses a project belonging to another memorial', () => {
    const other = insertOne(db, memorials, { decedentName: 'Someone Else' } as never);
    expect(() =>
      requestRender(db, {
        memorialId: other.id,
        projectId: project.id,
        cut: 'family',
        preset: 'draft360',
      }),
    ).toThrow(/does not belong/);
  });
});
