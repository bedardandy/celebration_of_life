/**
 * DB-backed durable job queue.
 *
 * Deliberately boring: one SQLite table, a lease, and exponential backoff. No
 * Redis, no Docker, no broker to install — a grieving family's laptop is not
 * the place to debug infrastructure, and neither is a solo dev's machine.
 *
 * Safety model:
 *  - claiming is a transaction: SELECT one eligible row, then UPDATE ... WHERE
 *    id = ? AND status = 'queued'. Two workers cannot win the same row.
 *  - a claim carries a lease; a crashed worker's job is reclaimed once the
 *    lease expires, rather than being stuck in 'running' forever.
 *  - failures back off exponentially and give up at maxAttempts.
 */
import { and, asc, desc, eq, inArray, lte, lt, sql } from 'drizzle-orm';
import { JobPayloadSchema, type JobPayload, type JobType } from '@col/schemas';
import type { Db } from './client';
import { jobs, type JobRow } from './schema';

export const DEFAULT_LEASE_MS = 30_000;
export const DEFAULT_MAX_ATTEMPTS = 3;

export type EnqueueOptions = {
  /** Higher runs first. */
  priority?: number;
  maxAttempts?: number;
  /** Delay before the job becomes eligible. */
  delayMs?: number;
  runAfter?: number;
  memorialId?: string | null;
};

/** Validates the payload before it ever reaches the table. */
export function enqueue(db: Db, payload: JobPayload, options: EnqueueOptions = {}): JobRow {
  const parsed = JobPayloadSchema.parse(payload);
  const now = Date.now();
  const rows = db
    .insert(jobs)
    .values({
      type: parsed.type,
      payload: parsed,
      status: 'queued',
      priority: options.priority ?? 0,
      maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      runAfter: options.runAfter ?? now + (options.delayMs ?? 0),
      memorialId: options.memorialId ?? null,
    })
    .returning()
    .all();
  const row = rows[0];
  if (!row) throw new Error('enqueue: insert returned no row');
  return row;
}

/**
 * Return expired-lease jobs to the queue. Called inside claimNext, and safe to
 * call on its own (e.g. at worker boot after an unclean shutdown).
 */
export function reclaimExpired(db: Db, now: number = Date.now()): number {
  return db
    .update(jobs)
    .set({ status: 'queued', lockedBy: null, leaseExpiresAt: null })
    .where(and(eq(jobs.status, 'running'), lt(jobs.leaseExpiresAt, now)))
    .run().changes;
}

export type ClaimOptions = {
  workerId: string;
  leaseMs?: number;
  /** Restrict to specific job types (e.g. a render-only worker). */
  types?: readonly JobType[];
  now?: number;
};

/** Claim at most one job. Returns undefined when there is nothing to do. */
export function claimNext(db: Db, options: ClaimOptions): JobRow | undefined {
  const now = options.now ?? Date.now();
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;

  return db.transaction((tx) => {
    tx.update(jobs)
      .set({ status: 'queued', lockedBy: null, leaseExpiresAt: null })
      .where(and(eq(jobs.status, 'running'), lt(jobs.leaseExpiresAt, now)))
      .run();

    const eligible = and(
      eq(jobs.status, 'queued'),
      lte(jobs.runAfter, now),
      options.types && options.types.length > 0
        ? inArray(jobs.type, options.types as JobType[])
        : undefined,
    );

    const candidates = tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(eligible)
      .orderBy(desc(jobs.priority), asc(jobs.runAfter), asc(jobs.id))
      .limit(1)
      .all();

    const candidate = candidates[0];
    if (!candidate) return undefined;

    // The `status = 'queued'` guard is what makes the claim atomic.
    const claimed = tx
      .update(jobs)
      .set({
        status: 'running',
        lockedBy: options.workerId,
        leaseExpiresAt: now + leaseMs,
        attempts: sql`${jobs.attempts} + 1`,
        startedAt: now,
      })
      .where(and(eq(jobs.id, candidate.id), eq(jobs.status, 'queued')))
      .returning()
      .all();

    return claimed[0];
  });
}

/** Extend the lease of a job still being worked on. Returns false if lost. */
export function heartbeat(
  db: Db,
  jobId: string,
  workerId: string,
  leaseMs: number = DEFAULT_LEASE_MS,
  now: number = Date.now(),
): boolean {
  const changes = db
    .update(jobs)
    .set({ leaseExpiresAt: now + leaseMs })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, 'running'), eq(jobs.lockedBy, workerId)))
    .run().changes;
  return changes > 0;
}

export function complete(db: Db, jobId: string, result?: unknown): JobRow | undefined {
  const now = Date.now();
  return db
    .update(jobs)
    .set({
      status: 'done',
      result: result ?? null,
      finishedAt: now,
      lastError: null,
      lockedBy: null,
      leaseExpiresAt: null,
    })
    .where(eq(jobs.id, jobId))
    .returning()
    .all()[0];
}

/** 1s, 2s, 4s, 8s … capped at 5 minutes. */
export function backoffMs(attempts: number, baseMs = 1_000, capMs = 300_000): number {
  const exp = baseMs * 2 ** Math.max(0, attempts - 1);
  return Math.min(exp, capMs);
}

export type FailResult = { row: JobRow | undefined; retrying: boolean; runAfter: number | null };

/**
 * Record a failure. Requeues with backoff while attempts remain, otherwise
 * parks the job in 'failed' with the last error retained for the UI.
 */
export function fail(db: Db, job: JobRow, error: unknown, now: number = Date.now()): FailResult {
  const message = error instanceof Error ? error.message : String(error);
  const attempts = job.attempts;
  const willRetry = attempts < job.maxAttempts;
  const runAfter = willRetry ? now + backoffMs(attempts) : null;

  const row = db
    .update(jobs)
    .set(
      willRetry
        ? {
            status: 'queued',
            lastError: message,
            runAfter: runAfter as number,
            lockedBy: null,
            leaseExpiresAt: null,
          }
        : {
            status: 'failed',
            lastError: message,
            finishedAt: now,
            lockedBy: null,
            leaseExpiresAt: null,
          },
    )
    .where(eq(jobs.id, job.id))
    .returning()
    .all()[0];

  return { row, retrying: willRetry, runAfter };
}

export function cancel(db: Db, jobId: string): JobRow | undefined {
  return db
    .update(jobs)
    .set({ status: 'cancelled', finishedAt: Date.now(), lockedBy: null, leaseExpiresAt: null })
    .where(and(eq(jobs.id, jobId), inArray(jobs.status, ['queued', 'running'])))
    .returning()
    .all()[0];
}

export function getJob(db: Db, jobId: string): JobRow | undefined {
  return db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1).all()[0];
}

export function countByStatus(db: Db): Record<string, number> {
  const rows = db
    .select({ status: jobs.status, n: sql<number>`count(*)` })
    .from(jobs)
    .groupBy(jobs.status)
    .all();
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
}

/** Parse a row's payload back into its discriminated-union type. */
export function jobPayload(row: JobRow): JobPayload {
  const parsed = JobPayloadSchema.parse(row.payload);
  if (parsed.type !== row.type) {
    throw new Error(`job ${row.id}: payload type "${parsed.type}" != row type "${row.type}"`);
  }
  return parsed;
}
