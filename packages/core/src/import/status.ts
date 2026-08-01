/**
 * What the collect screen says about an import that is under way.
 *
 * The job queue already knows everything: whether an import is waiting, running
 * or finished, and what it brought. So there is no import table — one query
 * against `jobs`, turned into one sentence.
 */
import { and, desc, eq, jobs, type Db, type JobRow } from '@col/db';
import { importInProgressLine, type ImportTally } from './google-photos';

export type ImportStatus = {
  jobId: string;
  state: 'waiting' | 'running' | 'done' | 'failed';
  /** The sentence for the screen. Always safe to show. */
  message: string;
  tally?: ImportTally;
  finishedAt?: number | null;
};

type StoredResult = { tally?: ImportTally; summary?: string };

/** The most recent Google import for this memorial, if there has been one. */
export function latestGoogleImport(db: Db, memorialId: string): ImportStatus | undefined {
  const row = db
    .select()
    .from(jobs)
    .where(and(eq(jobs.memorialId, memorialId), eq(jobs.type, 'import-google-photos')))
    .orderBy(desc(jobs.createdAt))
    .limit(1)
    .all()[0] as JobRow | undefined;
  if (!row) return undefined;

  if (row.status === 'queued' || row.status === 'running') {
    return {
      jobId: row.id,
      state: row.status === 'queued' ? 'waiting' : 'running',
      message: importInProgressLine(),
    };
  }

  if (row.status === 'done') {
    const result = (row.result ?? {}) as StoredResult;
    return {
      jobId: row.id,
      state: 'done',
      message:
        result.summary ?? 'Your photos came over from Google. They are with the rest of them now.',
      ...(result.tally ? { tally: result.tally } : {}),
      finishedAt: row.finishedAt,
    };
  }

  // Cancelled counts as failed here: either way nothing came, and the sentence
  // has to say what to do rather than what went wrong.
  return {
    jobId: row.id,
    state: 'failed',
    message:
      'The photos did not come over that time. Nothing was lost — starting again usually works.',
    finishedAt: row.finishedAt,
  };
}
