import {
  claimNext,
  complete,
  fail,
  heartbeat as renewLease,
  jobPayload,
  type Db,
  type JobRow,
} from '@col/db';
import type { JobType } from '@col/schemas';
import { handlers, type HandlerContext, type HandlerRegistry } from './handlers';
import { log as defaultLogger, type Logger } from './log';
import type { WorkerConfig } from './config';

export type RunOnceOptions = {
  db: Db;
  config: WorkerConfig;
  registry?: HandlerRegistry;
  logger?: Logger;
  /** Shutdown signal; forwarded to the handler. */
  signal?: AbortSignal;
};

export type RunOnceResult =
  | { status: 'idle' }
  | {
      status: 'done';
      job: JobRow;
      jobId: string;
      type: JobType;
      result: unknown;
      durationMs: number;
    }
  | {
      status: 'retrying' | 'failed';
      job: JobRow;
      jobId: string;
      type: JobType;
      error: string;
      runAfter: number | null;
      durationMs: number;
    };

/** Renew often enough that a slow job never loses its lease to itself. */
function heartbeatIntervalMs(leaseMs: number): number {
  return Math.max(1_000, Math.floor(leaseMs / 3));
}

/**
 * Claim at most one job, run it, and record the outcome. This is the entire
 * worker: the poll loop is just this function on a timer, which also makes it
 * the unit that tests can drive directly.
 */
export async function runOnce(options: RunOnceOptions): Promise<RunOnceResult> {
  const { db, config } = options;
  const registry = options.registry ?? handlers;
  const logger = options.logger ?? defaultLogger;

  const job = claimNext(db, {
    workerId: config.workerId,
    leaseMs: config.leaseMs,
    types: config.types,
  });
  if (!job) return { status: 'idle' };

  const startedAt = Date.now();
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onOuterAbort, { once: true });

  const beat = () => renewLease(db, job.id, config.workerId, config.leaseMs);
  const timer = setInterval(() => {
    if (!beat()) {
      logger.warn('lease lost, aborting job', { jobId: job.id, type: job.type });
      controller.abort();
    }
  }, heartbeatIntervalMs(config.leaseMs));
  timer.unref?.();

  const finish = () => {
    clearInterval(timer);
    options.signal?.removeEventListener('abort', onOuterAbort);
  };

  logger.info('job claimed', { jobId: job.id, type: job.type, attempt: job.attempts });

  try {
    const entry = registry.require(job.type);
    const ctx: HandlerContext = {
      db,
      job,
      payload: jobPayload(job),
      workerId: config.workerId,
      signal: controller.signal,
      heartbeat: beat,
      log: logger.child(job.type),
    };
    const result = await entry.run(ctx);
    const row = complete(db, job.id, result ?? null);
    const durationMs = Date.now() - startedAt;
    logger.info('job done', { jobId: job.id, type: job.type, durationMs });
    return {
      status: 'done',
      job: row ?? job,
      jobId: job.id,
      type: job.type,
      result: result ?? null,
      durationMs,
    };
  } catch (err) {
    const outcome = fail(db, job, err);
    const durationMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    logger[outcome.retrying ? 'warn' : 'error'](
      outcome.retrying ? 'job failed, will retry' : 'job failed, giving up',
      {
        jobId: job.id,
        type: job.type,
        attempt: job.attempts,
        maxAttempts: job.maxAttempts,
        error: message,
      },
    );
    return {
      status: outcome.retrying ? 'retrying' : 'failed',
      job: outcome.row ?? job,
      jobId: job.id,
      type: job.type,
      error: message,
      runAfter: outcome.runAfter,
      durationMs,
    };
  } finally {
    finish();
  }
}

/** Drain the queue: run jobs until there is nothing eligible left. */
export async function drain(options: RunOnceOptions & { max?: number }): Promise<RunOnceResult[]> {
  const max = options.max ?? 100;
  const results: RunOnceResult[] = [];
  for (let i = 0; i < max; i += 1) {
    if (options.signal?.aborted) break;
    const result = await runOnce(options);
    if (result.status === 'idle') break;
    results.push(result);
  }
  return results;
}
