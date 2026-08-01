/**
 * Who may see a finished video.
 *
 * Two doors into the same file. The organiser, holding a session cookie, is one
 * — that is the download on the deliver screen and the playback screen at the
 * venue. A private viewing link is the other: a capability URL somebody was
 * sent, scoped to one memorial, revocable, and not permitted to save a copy
 * unless the family said it could.
 *
 * The rule both doors share: a render that does not exist, a render belonging to
 * another family, and a render that has not finished all look identical from
 * outside — 403, no detail. Nothing here tells a stranger whose memorial an id
 * belongs to.
 */
import { authorizeOrganizer, watchTokenAllows } from '@col/core';
import { getById, memorials, renderJobs, type Memorial, type RenderJob } from '@col/db';
import { db } from './db';
import { readSession } from './session';

export type RenderAccess = {
  job: RenderJob;
  memorial: Memorial;
  /** How the caller got in. Watch links get inline playback, never an attachment. */
  via: 'session' | 'watch';
  canDownload: boolean;
};

export type RenderAccessOptions = {
  /** The caller wants the bytes as a file to keep, not as something to play. */
  forDownload?: boolean;
};

/**
 * Resolve a render id plus whatever credential the request carried, or nothing.
 * `undefined` always means 403 — never 404, never an explanation.
 */
export async function authorizeRender(
  request: Request,
  renderJobId: string,
  options: RenderAccessOptions = {},
): Promise<RenderAccess | undefined> {
  const job = getById(db(), renderJobs, renderJobId);
  if (!job?.outputBlobKey || job.status !== 'done') return undefined;

  const memorial = getById(db(), memorials, job.memorialId);
  if (!memorial || memorial.deletedAt != null) return undefined;

  const token = new URL(request.url).searchParams.get('watch')?.trim();
  if (token) {
    if (!watchTokenAllows(db(), token, job, { forDownload: options.forDownload === true })) {
      return undefined;
    }
    return {
      job,
      memorial,
      via: 'watch',
      canDownload: watchTokenAllows(db(), token, job, { forDownload: true }),
    };
  }

  const session = await readSession();
  if (!session || !authorizeOrganizer(db(), session, job.memorialId).ok) return undefined;
  return { job, memorial, via: 'session', canDownload: true };
}
