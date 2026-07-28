import { reclaimExpired, type Db } from '@col/db';
import { runOnce, type RunOnceResult } from './runner';
import { handlers, type HandlerRegistry } from './handlers';
import { log as defaultLogger, type Logger } from './log';
import type { WorkerConfig } from './config';

export type WorkerOptions = {
  db: Db;
  config: WorkerConfig;
  registry?: HandlerRegistry;
  logger?: Logger;
};

export type Worker = {
  readonly config: WorkerConfig;
  /** Resolves when the loop has stopped and the in-flight job has settled. */
  start: () => Promise<void>;
  /** Ask the loop to stop after the current job. Idempotent. */
  stop: () => void;
  /** Abort the in-flight job as well as stopping the loop. */
  abort: () => void;
  readonly running: boolean;
};

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * The poll loop.
 *
 * Polling a SQLite table every 1.5s is not clever, and that is the point: no
 * broker to install, no daemon to keep alive, and a queue you can inspect with
 * `sqlite3 data/app.db 'select * from jobs'` when something has gone wrong at
 * eleven at night.
 */
export function createWorker(options: WorkerOptions): Worker {
  const { db, config } = options;
  const registry = options.registry ?? handlers;
  const logger = options.logger ?? defaultLogger;

  // `stopping` ends the loop politely; `hard` also aborts the running job.
  const stopping = new AbortController();
  const hard = new AbortController();
  let running = false;

  async function start(): Promise<void> {
    if (running) return;
    running = true;

    const reclaimed = reclaimExpired(db);
    if (reclaimed > 0) logger.warn('requeued jobs with expired leases', { count: reclaimed });

    logger.info('polling for jobs', {
      workerId: config.workerId,
      everyMs: config.pollIntervalMs,
      types: config.types ? config.types.join(',') : 'all',
    });

    try {
      while (!stopping.signal.aborted) {
        let result: RunOnceResult;
        try {
          result = await runOnce({ db, config, registry, logger, signal: hard.signal });
        } catch (err) {
          // runOnce records job-level failures itself; reaching here means the
          // queue itself misbehaved. Back off rather than spin.
          logger.error('poll cycle failed', {
            error: err instanceof Error ? err.message : String(err),
          });
          await sleep(config.pollIntervalMs, stopping.signal);
          continue;
        }
        // Only idle when the queue is empty — otherwise keep going at full tilt.
        if (result.status === 'idle') await sleep(config.pollIntervalMs, stopping.signal);
      }
    } finally {
      running = false;
      logger.info('worker stopped');
    }
  }

  return {
    config,
    start,
    stop: () => stopping.abort(),
    abort: () => {
      stopping.abort();
      hard.abort();
    },
    get running() {
      return running;
    },
  };
}
