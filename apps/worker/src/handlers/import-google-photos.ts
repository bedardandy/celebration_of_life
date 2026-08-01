/**
 * Bringing a family's photographs over from Google Photos.
 *
 * The work itself lives in `@col/core` (`runGooglePhotosImport`), where it can
 * be tested against a fake `fetch` with no queue involved. What belongs here is
 * the part that belongs to the queue, and one thing that belongs to nobody
 * else: the credential.
 *
 * The access token arrives sealed inside the job payload — AES-GCM, keyed from
 * `SESSION_SECRET`, valid for about an hour — because a token for somebody's
 * photo library must not become a column with a lifetime. The moment the import
 * finishes, successfully or not, the sealed value is blanked out of the payload
 * so that even the encrypted form does not linger in a row somebody may keep
 * for a year. docs/google-photos.md states the tradeoff plainly.
 */
import {
  open,
  runGooglePhotosImport,
  GOOGLE_TOKEN_PURPOSE,
  type GoogleToken,
  type ImportStore,
} from '@col/core';
import { eq, jobs, type Db } from '@col/db';
import { getBlobStore, type BlobStore } from '@col/storage';
import { defineHandler } from './types';

let storeOverride: BlobStore | undefined;
let fetchOverride: typeof fetch | undefined;

export function setImportBlobStore(store: BlobStore | undefined): void {
  storeOverride = store;
}

/** Injectable for tests. Nothing in this repo's tests reaches the network. */
export function setGoogleFetch(impl: typeof fetch | undefined): void {
  fetchOverride = impl;
}

function store(): ImportStore {
  return storeOverride ?? getBlobStore();
}

export type ImportGoogleOutcome = {
  status: 'done' | 'skipped';
  added: number;
  expired: number;
  skipped: number;
  total: number;
  /** The sentence the collect screen shows. Partial success says so. */
  summary: string;
  tally: { added: number; expired: number; skipped: number; total: number };
  reason?: string;
};

export const importGooglePhotosHandler = defineHandler('import-google-photos', async (ctx) => {
  const { db, payload, log } = ctx;

  const opened = open<GoogleToken>(GOOGLE_TOKEN_PURPOSE, payload.sealedToken);
  if (!opened.ok) {
    scrubToken(db, ctx.job.id);
    // Not retried: an expired or tampered envelope will not become valid on the
    // third attempt, and the screen already knows how to say "start again".
    return {
      status: 'skipped',
      added: 0,
      expired: 0,
      skipped: 0,
      total: 0,
      tally: { added: 0, expired: 0, skipped: 0, total: 0 },
      summary:
        'The connection to Google timed out before the photos came over. ' +
        'Starting again takes a moment and nothing was lost.',
      reason: opened.reason,
    } satisfies ImportGoogleOutcome;
  }

  try {
    const outcome = await runGooglePhotosImport(db, store(), {
      memorialId: payload.memorialId,
      sessionId: payload.sessionId,
      accessToken: opened.value.accessToken,
      participantId: payload.participantId ?? null,
      ...(fetchOverride ? { fetchImpl: fetchOverride } : {}),
      // Downloading forty photographs takes a while; keep the lease alive.
      onProgress: () => void ctx.heartbeat(),
    });

    if (outcome.expiredFilenames.length > 0) {
      log.warn('some Google links expired before we could fetch them', {
        memorialId: payload.memorialId,
        expired: outcome.expiredFilenames.length,
      });
    }
    log.info('Google import finished', {
      memorialId: payload.memorialId,
      ...outcome.tally,
    });

    return {
      status: 'done',
      ...outcome.tally,
      tally: outcome.tally,
      summary: outcome.summary,
    } satisfies ImportGoogleOutcome;
  } finally {
    scrubToken(db, ctx.job.id);
  }
});

/**
 * Take the credential back out of the row.
 *
 * The job row is kept — it is what the collect screen reads to say what
 * arrived — but nothing about it needs the token any more.
 */
function scrubToken(db: Db, jobId: string): void {
  const row = db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1).all()[0];
  if (!row) return;
  const payload = row.payload as Record<string, unknown> | null;
  if (!payload || typeof payload !== 'object' || !('sealedToken' in payload)) return;
  db.update(jobs)
    .set({ payload: { ...payload, sealedToken: 'used' } })
    .where(eq(jobs.id, jobId))
    .run();
}
