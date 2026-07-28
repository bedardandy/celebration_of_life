/**
 * Asking for a video, and knowing where it has got to.
 *
 * The deliver screen is the last one a family sees, often the night before a
 * funeral, and the only honest thing to say about a render is how far through
 * it is and roughly how long that leaves. Every promise this module makes is
 * one it can keep:
 *
 *  - it never claims a render is done until ffprobe has agreed the file plays;
 *  - it never shows a percentage it did not measure;
 *  - it says "you can close this page", and means it, because the work is in a
 *    durable queue and not in a browser tab.
 */
import type { CutName, RenderPreset } from '@col/schemas';
import {
  and,
  desc,
  enqueue,
  eq,
  getById,
  insertOne,
  listWhere,
  renderJobs,
  slideshowProjects,
  updateById,
  type Db,
  type RenderJob,
} from '@col/db';

/** What each file is called on the screen. Never "draft360" in front of a person. */
export const RENDER_PRESET_LABELS: Record<RenderPreset, string> = {
  draft360: 'Quick preview',
  final1080: 'The video for the service',
  backup720: 'Smaller backup copy',
};

/** What each preset is for, in the words the screen uses. */
export const PRESET_INTENT: Record<RenderPreset, string> = {
  draft360: 'A quick, small version to check the order and the words.',
  final1080: 'The one for the service: full quality, 1080p.',
  backup720: 'A smaller copy, for a venue machine that struggles with 1080p.',
};

export type RequestRenderInput = {
  memorialId: string;
  projectId: string;
  cut: CutName;
  preset: RenderPreset;
};

export type RequestRenderResult = {
  renderJob: RenderJob;
  /** True when an identical render was already queued or running. */
  reused: boolean;
};

/**
 * Queue a render, or hand back the one already doing that exact job.
 *
 * Someone pressing the button twice — which a person waiting on a slow page
 * absolutely will — must not start a second five-minute encode. A *finished*
 * render is not reused, because the slideshow may have changed since; that is a
 * new file, deliberately.
 */
export function requestRender(db: Db, input: RequestRenderInput): RequestRenderResult {
  const project = getById(db, slideshowProjects, input.projectId);
  if (!project || project.memorialId !== input.memorialId) {
    throw new Error(`slideshow project ${input.projectId} does not belong to ${input.memorialId}`);
  }

  const inFlight = listWhere(
    db,
    renderJobs,
    and(
      eq(renderJobs.projectId, input.projectId),
      eq(renderJobs.cut, input.cut),
      eq(renderJobs.preset, input.preset),
    ),
    50,
  ).find((row) => row.status === 'queued' || row.status === 'running');

  if (inFlight) return { renderJob: inFlight, reused: true };

  const renderJob = insertOne(db, renderJobs, {
    memorialId: input.memorialId,
    projectId: input.projectId,
    cut: input.cut,
    preset: input.preset,
    status: 'queued',
    progress: 0,
  } as never);

  const job = enqueue(
    db,
    {
      type: 'render',
      memorialId: input.memorialId,
      projectId: input.projectId,
      renderJobId: renderJob.id,
      cut: input.cut,
      preset: input.preset,
    },
    // Above photo analysis and EDL generation: a render is the only job with a
    // funeral waiting at the end of it.
    { memorialId: input.memorialId, priority: 10, maxAttempts: 3 },
  );

  const updated = updateById(db, renderJobs, renderJob.id, { jobId: job.id });
  return { renderJob: updated ?? renderJob, reused: false };
}

/** Every render for a memorial, newest first. */
export function renderJobsFor(db: Db, memorialId: string, limit = 40): RenderJob[] {
  return db
    .select()
    .from(renderJobs)
    .where(eq(renderJobs.memorialId, memorialId))
    .orderBy(desc(renderJobs.createdAt))
    .limit(limit)
    .all();
}

/** The most recent render of exactly this cut and preset. */
export function latestRender(
  db: Db,
  memorialId: string,
  cut: CutName,
  preset: RenderPreset,
): RenderJob | undefined {
  return renderJobsFor(db, memorialId).find((row) => row.cut === cut && row.preset === preset);
}

/* -------------------------------------------------------------------------- */
/* progress, honestly                                                          */
/* -------------------------------------------------------------------------- */

/**
 * How long a render takes, and why this module refuses to predict it.
 *
 * Measured here: about 2 frames a second at 1080p on four slow cores with
 * software rasterisation — roughly twelve times the length of the video — and
 * perhaps ten times faster on a developer laptop with a GPU. That spread is why
 * the copy never states a number until the render's *own* progress justifies
 * one. A stated ETA that is out by an hour is worse than no ETA, and a family
 * three days from a funeral will believe whatever this screen says.
 */
export const MEASURED_1080P_FPS_RANGE = [2, 25] as const;

export type RenderProgressView = {
  status: RenderJob['status'];
  /** 0..100, rounded. */
  percent: number;
  /** One sentence. Always true, never a countdown. */
  message: string;
  /** True while the family may safely close the page. */
  working: boolean;
  done: boolean;
  failed: boolean;
};

export function describeRenderProgress(
  job: RenderJob | undefined,
  options: { now?: number } = {},
): RenderProgressView {
  if (!job) {
    return {
      status: 'queued',
      percent: 0,
      message: 'Nothing is being made yet.',
      working: false,
      done: false,
      failed: false,
    };
  }

  const percent = Math.max(0, Math.min(100, Math.round(job.progress * 100)));

  if (job.status === 'done') {
    return {
      status: 'done',
      percent: 100,
      message: 'The video is ready to download.',
      working: false,
      done: true,
      failed: false,
    };
  }
  if (job.status === 'failed' || job.status === 'cancelled') {
    return {
      status: job.status,
      percent,
      message:
        job.status === 'cancelled'
          ? 'That render was stopped. You can start it again whenever you like.'
          : 'Something went wrong making the video. Starting it again usually works, and we keep the details.',
      working: false,
      done: false,
      failed: true,
    };
  }

  if (job.status === 'queued') {
    return {
      status: 'queued',
      percent,
      message: 'In the queue. It will start in a moment — you can close this page.',
      working: true,
      done: false,
      failed: false,
    };
  }

  const now = options.now ?? Date.now();
  const elapsedSec = job.startedAt ? Math.max(0, (now - job.startedAt) / 1000) : 0;
  return {
    status: 'running',
    percent,
    message: remainingMessage(percent, elapsedSec),
    working: true,
    done: false,
    failed: false,
  };
}

/**
 * "About four minutes left" — but only once there is enough evidence.
 *
 * Below a tenth of the way through, an extrapolation from elapsed time is
 * noise, so the copy stays honest and vague. This is the single place the
 * five-to-fifteen-minute promise on the screen is allowed to become a number.
 */
function remainingMessage(percent: number, elapsedSec: number): string {
  if (percent < 10 || elapsedSec < 20) {
    return 'Making the video now. It usually takes about 5–15 minutes, and longer for a long video — you can close this page, we will keep working.';
  }
  const totalSec = elapsedSec / (percent / 100);
  const remainingMin = Math.max(1, Math.round((totalSec - elapsedSec) / 60));
  const plural = remainingMin === 1 ? 'minute' : 'minutes';
  return `About ${remainingMin} more ${plural}. You can close this page — we will keep working.`;
}

/* -------------------------------------------------------------------------- */
/* what the deliver screen shows                                               */
/* -------------------------------------------------------------------------- */

export type DeliverableRow = {
  job: RenderJob;
  cut: CutName;
  preset: RenderPreset;
  filename: string;
  /** Present once the render finished and passed verification. */
  downloadHref?: string;
  progress: RenderProgressView;
  /** "5 min 12 sec", from the verified file rather than from the plan. */
  lengthLabel?: string;
};

/** Ready-to-download renders count as delivered; anything else is in progress. */
export function hasDeliverable(db: Db, memorialId: string): boolean {
  return renderJobsFor(db, memorialId).some(
    (job) => job.status === 'done' && job.outputBlobKey != null,
  );
}

export function isRendering(db: Db, memorialId: string): boolean {
  return renderJobsFor(db, memorialId).some(
    (job) => job.status === 'queued' || job.status === 'running',
  );
}
