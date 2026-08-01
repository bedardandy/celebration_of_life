/**
 * Making the file.
 *
 * This is the last job in the product and the one with a funeral on the other
 * end of it, so it is written to be paranoid in a specific way: it does not
 * trust its own output. The render is not "done" when Remotion returns and it
 * is not "done" when ffmpeg exits — it is done when ffprobe has confirmed the
 * file is H.264 in yuv420p, carries an AAC track, has its index at the front,
 * and runs the length the timeline promised. Anything else fails the job, which
 * retries, rather than handing a family a video that will not play.
 *
 * The shape:
 *
 *   1. resolve the EDL and the chosen cut into a timeline (the same arithmetic
 *      the browser preview used — never a second opinion);
 *   2. copy the render2400 variants out of the blob store into a scratch
 *      directory, where a local HTTP server can serve them to the renderer;
 *   3. render the picture, silent, at the requested preset;
 *   4. build the audio — a normalised music bed, or a silent AAC track for the
 *      side-loaded mode — and mux it in with faststart;
 *   5. verify, store, and record what ffprobe said.
 *
 * Everything lands in a scratch directory that is removed whether the job
 * succeeded or not.
 */
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { CutName, Edl, RenderPreset, ResolvedTimeline } from '@col/schemas';
import {
  assetVariants,
  eq,
  getById,
  listWhere,
  memorials,
  musicTracks,
  renderJobs,
  slideshowProjects,
  updateById,
  type Db,
  type RenderJob,
} from '@col/db';
import { deliverableFilename, projectCut, projectEdl, currentSelection } from '@col/core';
import {
  buildMusicBed,
  buildSilentTrack,
  mediaDurationSec,
  muxAudioIntoVideo,
  verifyDeliverable,
  type DeliverableCheck,
} from '@col/media';
import { blobKeys, getBlobStore, type BlobStore } from '@col/storage';
import { renderPreset, renderTribute } from '@col/video/render';
import { defineHandler } from './types';

/** Which variant the renderer wants, and what it falls back to. */
const VARIANT_PREFERENCE = ['render2400', 'web1600', 'original'] as const;

/** Progress is written at most this often: the queue is not a progress bar. */
export const PROGRESS_WRITE_INTERVAL_MS = 2_000;
/** …or when it has moved this far, whichever comes first. */
export const PROGRESS_WRITE_DELTA = 0.02;

export type RenderOutcome = {
  status: 'done';
  renderJobId: string;
  cut: CutName;
  preset: RenderPreset;
  outputBlobKey: string;
  durationSec: number;
  byteSize: number;
  filename: string;
  audioMode: 'cleared' | 'sideloaded';
  /** Wall-clock split, so a slow render can be explained rather than guessed at. */
  timings: { renderMs: number; audioMs: number; totalMs: number };
  ffprobe: DeliverableCheck;
};

/** Injectable for tests; production uses the process-wide store. */
let storeOverride: BlobStore | undefined;

export function setRenderBlobStore(store: BlobStore | undefined): void {
  storeOverride = store;
}

function store(): BlobStore {
  return storeOverride ?? getBlobStore();
}

/* -------------------------------------------------------------------------- */

export const renderHandler = defineHandler('render', async (ctx) => {
  const { db, payload, log } = ctx;
  const startedAt = Date.now();

  const renderJob = getById(db, renderJobs, payload.renderJobId);
  if (!renderJob) throw new Error(`no render job ${payload.renderJobId}`);
  if (renderJob.memorialId !== payload.memorialId) {
    throw new Error(`render job ${renderJob.id} does not belong to ${payload.memorialId}`);
  }

  // Marked running before anything else can go wrong. Every failure from here
  // on is recorded on the row, because a render row still saying "queued" is a
  // deliver screen still saying "it will start in a moment" — forever.
  updateById(db, renderJobs, renderJob.id, {
    status: 'running',
    startedAt: Date.now(),
    progress: 0,
    error: null,
  });

  const scratch = await mkdtemp(path.join(tmpdir(), `col-render-${renderJob.id}-`));

  try {
    const memorial = getById(db, memorials, payload.memorialId);
    if (!memorial) throw new Error(`memorial ${payload.memorialId} not found`);
    const project = getById(db, slideshowProjects, payload.projectId);
    const edl = projectEdl(project);
    if (!project || !edl) throw new Error(`slideshow project ${payload.projectId} has no EDL yet`);

    const timeline = projectCut(edl, payload.cut);
    if (timeline.slides.length === 0) throw new Error('this cut has no slides in it');

    const outcome = await runRender({
      db,
      scratch,
      renderJob,
      edl,
      timeline,
      decedentName: memorial.decedentName,
      projectId: payload.projectId,
      memorialId: payload.memorialId,
      cut: payload.cut,
      preset: payload.preset,
      signal: ctx.signal,
      heartbeat: () => ctx.heartbeat(),
      onProgress: (progress) => {
        updateById(db, renderJobs, renderJob.id, { progress });
      },
      log,
      startedAt,
    });

    updateById(db, renderJobs, renderJob.id, {
      status: 'done',
      progress: 1,
      outputBlobKey: outcome.outputBlobKey,
      durationSec: outcome.durationSec,
      ffprobeMeta: outcome.ffprobe as unknown as Record<string, unknown>,
      finishedAt: Date.now(),
      error: null,
    });

    log.info('render ready', {
      renderJobId: renderJob.id,
      preset: outcome.preset,
      cut: outcome.cut,
      seconds: Math.round(outcome.durationSec),
      megabytes: Math.round((outcome.byteSize / 1024 / 1024) * 10) / 10,
      totalMs: outcome.timings.totalMs,
    });

    return outcome;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The queue decides whether to retry; the render row only records where it
    // got to, so the deliver screen can say something true in the meantime.
    // Mirrors the queue's own rule exactly (`attempts < maxAttempts` in
    // `fail()`), so the row a family's screen reads never says "failed" while
    // the queue is still going to try again.
    const attemptsLeft = ctx.job.attempts < ctx.job.maxAttempts;
    updateById(db, renderJobs, renderJob.id, {
      status: attemptsLeft ? 'queued' : 'failed',
      error: message,
      ...(attemptsLeft ? {} : { finishedAt: Date.now() }),
    });
    throw error;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* the work itself                                                             */
/* -------------------------------------------------------------------------- */

type RunRenderInput = {
  db: Db;
  scratch: string;
  renderJob: RenderJob;
  edl: Edl;
  timeline: ResolvedTimeline;
  decedentName: string;
  memorialId: string;
  projectId: string;
  cut: CutName;
  preset: RenderPreset;
  signal: AbortSignal;
  heartbeat: () => boolean;
  onProgress: (progress: number) => void;
  log: {
    info: (message: string, fields?: Record<string, unknown>) => void;
    warn: (message: string, fields?: Record<string, unknown>) => void;
  };
  startedAt: number;
};

/**
 * Exported so the render pipeline can be exercised end to end in a test without
 * a queue, a lease or a retry policy in the way.
 */
export async function runRender(input: RunRenderInput): Promise<RenderOutcome> {
  const { db, scratch, timeline } = input;
  const silentFile = path.join(scratch, 'silent.mp4');
  const audioFile = path.join(scratch, 'audio.m4a');
  const finalFile = path.join(scratch, 'final.mp4');

  const assetFiles = await fetchPhotos(db, input.edl, timeline, scratch);

  /* 1. the picture ---------------------------------------------------------- */

  // Rendering owns most of the wall clock, so its progress is most of the bar —
  // the audio work is the last tenth, and saying so keeps the number honest.
  let lastWrite = 0;
  let lastProgress = 0;
  const renderResult = await renderTribute({
    edl: input.edl,
    timeline,
    assetFiles,
    preset: input.preset,
    outputFile: silentFile,
    signal: input.signal,
    onProgress: (progress) => {
      input.heartbeat();
      const scaled = Math.min(0.9, progress * 0.9);
      const now = Date.now();
      if (
        now - lastWrite < PROGRESS_WRITE_INTERVAL_MS &&
        scaled - lastProgress < PROGRESS_WRITE_DELTA
      ) {
        return;
      }
      lastWrite = now;
      lastProgress = scaled;
      input.onProgress(scaled);
    },
  });

  input.onProgress(0.9);
  input.heartbeat();

  /* 2. the sound ------------------------------------------------------------ */

  const audioStartedAt = Date.now();
  const selection = currentSelection(db, input.projectId);
  const track = selection?.trackId ? getById(db, musicTracks, selection.trackId) : undefined;
  const wantsMusic = (selection?.mode ?? input.edl.audio.mode) === 'cleared' && track?.blobKey;

  let audioMode: 'cleared' | 'sideloaded' = 'sideloaded';

  if (wantsMusic && track?.blobKey) {
    // The extension is cosmetic — ffmpeg probes the content — but keeping the
    // real one makes a scratch directory readable when a render goes wrong.
    const trackFile = await materialise(
      track.blobKey,
      path.join(scratch, `track${path.extname(track.blobKey) || '.m4a'}`),
    );
    const sourceDurationSec = track.durationSec ?? (await mediaDurationSec(trackFile)) ?? 0;
    if (sourceDurationSec > 0) {
      const bed = await buildMusicBed({
        trackFile,
        outputFile: audioFile,
        sourceDurationSec,
        targetDurationSec: renderResult.durationSec,
        startOffsetSec: selection?.startOffsetSec ?? input.edl.audio.startOffsetSec ?? 0,
      });
      audioMode = 'cleared';
      if (bed.singlePass) {
        input.log.warn('loudness measurement could not be read; used a single pass', {
          renderJobId: input.renderJob.id,
        });
      }
      if (bed.looped) {
        input.log.info('music was looped to cover the video', {
          renderJobId: input.renderJob.id,
          trackSec: Math.round(sourceDurationSec),
          videoSec: Math.round(renderResult.durationSec),
        });
      }
    } else {
      input.log.warn('the chosen track has no readable length; rendering silent', {
        renderJobId: input.renderJob.id,
      });
    }
  }

  if (audioMode === 'sideloaded') {
    // A real, silent AAC stream rather than no audio at all: some venue players
    // refuse to seek — and a few refuse to open — a file with no audio track.
    await buildSilentTrack({ outputFile: audioFile, durationSec: renderResult.durationSec });
  }

  input.heartbeat();
  await muxAudioIntoVideo({ videoFile: silentFile, audioFile, outputFile: finalFile });
  const audioMs = Date.now() - audioStartedAt;
  input.onProgress(0.97);

  /* 3. proof ---------------------------------------------------------------- */

  const ffprobe = await verifyDeliverable(finalFile, {
    durationSec: timeline.totalSec,
    width: renderResult.width,
    height: renderResult.height,
    requireAudio: true,
  });
  if (!ffprobe.ok) {
    throw new Error(`the rendered file would not play reliably: ${ffprobe.problems.join('; ')}`);
  }

  /* 4. keep it -------------------------------------------------------------- */

  const filename = deliverableFilename({
    decedentName: input.decedentName,
    cut: input.cut,
    preset: input.preset,
  });
  const outputBlobKey = blobKeys.render(
    input.memorialId,
    `${input.renderJob.id}-${input.cut}-${input.preset}`,
  );
  // Streamed rather than read into a Buffer: a five-minute 1080p file is a few
  // hundred megabytes, and a worker that holds one in memory per render is a
  // worker that falls over on the day everybody needs it.
  const put = await store().put(outputBlobKey, createReadStream(finalFile), 'video/mp4');

  return {
    status: 'done',
    renderJobId: input.renderJob.id,
    cut: input.cut,
    preset: input.preset,
    outputBlobKey: put.key,
    durationSec: ffprobe.durationSec ?? renderResult.durationSec,
    byteSize: put.byteSize,
    filename,
    audioMode,
    timings: {
      renderMs: renderResult.renderMs,
      audioMs,
      totalMs: Date.now() - input.startedAt,
    },
    ffprobe,
  };
}

/* -------------------------------------------------------------------------- */
/* photographs                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Copy every photograph this cut needs out of the blob store.
 *
 * `render2400` first — that is the variant made for exactly this — falling back
 * down the ladder rather than failing: a photograph that arrived five minutes
 * ago and has only a web1600 should still be in the video, slightly softer,
 * instead of leaving a hole where somebody's face was.
 *
 * A local-disk store hands back a path and the file is copied; any other store
 * is streamed. Either way the renderer only ever sees the scratch directory.
 */
async function fetchPhotos(
  db: Db,
  edl: Edl,
  timeline: ResolvedTimeline,
  scratch: string,
): Promise<Record<string, string>> {
  // The EDL names the variant each photograph should come from — which is how
  // an accepted enhancement reaches the video — and the ladder below is only a
  // fallback for a photograph whose chosen copy is not on disk.
  const wanted = new Map<string, string>();
  for (const entry of timeline.slides) {
    const slide = edl.slides[entry.slideId];
    if (slide?.kind === 'photo') wanted.set(slide.assetId, slide.variant);
  }

  const out: Record<string, string> = {};
  for (const [assetId, requested] of wanted) {
    const variants = listWhere(db, assetVariants, eq(assetVariants.assetId, assetId), 10);
    const chosen = [requested, ...VARIANT_PREFERENCE]
      .map((kind) => variants.find((variant) => variant.kind === kind))
      .find(Boolean);
    if (!chosen) continue;

    const extension = chosen.mime.includes('png')
      ? 'png'
      : chosen.mime.includes('webp')
        ? 'webp'
        : 'jpg';
    const file = path.join(scratch, `${assetId}.${extension}`);
    await materialise(chosen.blobKey, file);
    out[assetId] = file;
  }
  return out;
}

/** Blob key → a real file on disk in the scratch directory. */
async function materialise(blobKey: string, destination: string): Promise<string> {
  const blobStore = store();
  const direct = blobStore.getPath?.(blobKey);
  if (direct) {
    await copyFile(direct, destination);
    return destination;
  }
  await pipeline(await blobStore.getStream(blobKey), createWriteStream(destination));
  return destination;
}

/** Re-exported so a caller can size a scratch disk before starting a render. */
export { renderPreset };
