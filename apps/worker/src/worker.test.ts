import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, enqueue, getJob, type Db } from '@col/db';
import { createRegistry, defineHandler, handlers } from './handlers';
import { runOnce, drain } from './runner';
import { createWorker } from './worker';
import { loadWorkerConfig, type WorkerConfig } from './config';
import type { Logger } from './log';

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => silentLogger,
};

const config: WorkerConfig = {
  workerId: 'test-worker',
  pollIntervalMs: 10,
  leaseMs: 5_000,
  maxAttempts: 3,
};

let db: Db;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  db.$sqlite.close();
});

describe('runOnce', () => {
  it('is idle when the queue is empty', async () => {
    expect(await runOnce({ db, config, logger: silentLogger })).toEqual({ status: 'idle' });
  });

  it('claims, runs and completes a noop job', async () => {
    const queued = enqueue(db, { type: 'noop', sleepMs: 5, note: 'hello' });
    expect(queued.status).toBe('queued');

    const result = await runOnce({ db, config, logger: silentLogger });
    expect(result.status).toBe('done');
    if (result.status !== 'done') throw new Error('expected done');
    expect(result.jobId).toBe(queued.id);
    expect(result.result).toEqual({ sleptMs: 5, note: 'hello' });

    const row = getJob(db, queued.id);
    expect(row?.status).toBe('done');
    expect(row?.attempts).toBe(1);
    expect(row?.lockedBy).toBeNull();
    expect(row?.leaseExpiresAt).toBeNull();
    expect(row?.finishedAt).toBeTypeOf('number');
  });

  it('applies the payload default when sleepMs is omitted', async () => {
    enqueue(db, { type: 'noop' } as never);
    const result = await runOnce({ db, config, logger: silentLogger });
    if (result.status !== 'done') throw new Error('expected done');
    expect(result.result).toEqual({ sleptMs: 100 });
  });

  it('takes one job per call, in priority order', async () => {
    enqueue(db, { type: 'noop', sleepMs: 0, note: 'low' });
    const high = enqueue(db, { type: 'noop', sleepMs: 0, note: 'high' }, { priority: 10 });

    const first = await runOnce({ db, config, logger: silentLogger });
    if (first.status !== 'done') throw new Error('expected done');
    expect(first.jobId).toBe(high.id);

    const rest = await drain({ db, config, logger: silentLogger });
    expect(rest).toHaveLength(1);
    expect((await runOnce({ db, config, logger: silentLogger })).status).toBe('idle');
  });

  it('does not claim a job whose runAfter is in the future', async () => {
    enqueue(db, { type: 'noop', sleepMs: 0 }, { delayMs: 60_000 });
    expect((await runOnce({ db, config, logger: silentLogger })).status).toBe('idle');
  });

  it('retries with backoff, then gives up at maxAttempts', async () => {
    const boom = createRegistry([
      defineHandler('noop', async () => {
        throw new Error('kaboom');
      }),
    ]);
    const job = enqueue(db, { type: 'noop', sleepMs: 0 }, { maxAttempts: 2 });

    const first = await runOnce({ db, config, registry: boom, logger: silentLogger });
    expect(first.status).toBe('retrying');
    if (first.status === 'idle' || first.status === 'done') throw new Error('expected retrying');
    expect(first.error).toBe('kaboom');
    expect(first.runAfter).toBeGreaterThan(Date.now());
    expect(getJob(db, job.id)?.status).toBe('queued');

    // Second attempt: eligible immediately if we pretend the backoff elapsed.
    db.$sqlite.prepare('update jobs set run_after = 0').run();
    const second = await runOnce({ db, config, registry: boom, logger: silentLogger });
    expect(second.status).toBe('failed');

    const row = getJob(db, job.id);
    expect(row?.status).toBe('failed');
    expect(row?.attempts).toBe(2);
    expect(row?.lastError).toBe('kaboom');
  });

  it('fails a job whose type has no handler, naming the registered ones', async () => {
    const job = enqueue(db, {
      type: 'purge-blobs',
      memorialId: 'memorial-1',
      prefix: 'memorial/memorial-1',
    });
    const result = await runOnce({ db, config, logger: silentLogger });
    if (result.status === 'idle' || result.status === 'done') throw new Error('expected failure');
    expect(result.error).toMatch(/No handler registered for job type "purge-blobs"/);
    expect(result.error).toMatch(/Registered: noop/);
    expect(getJob(db, job.id)?.status).toBe('queued'); // first of three attempts
  });
});

describe('handler registry', () => {
  it('registers a handler for every job type that has one', () => {
    // Asserted by containment rather than equality: phases land in parallel,
    // and a new handler arriving is not a regression in this test's subject.
    expect(handlers.types()).toContain('noop');
    expect(handlers.types()).toContain('ingest-asset');
  });

  it('refuses two handlers for the same type', () => {
    const entry = defineHandler('noop', async () => null);
    expect(() => createRegistry([entry, entry])).toThrow(/duplicate handler/);
  });

  it('rejects a payload that does not match the handler it was routed to', async () => {
    const entry = defineHandler('render', async () => null);
    await expect(
      entry.run({
        db,
        job: {} as never,
        payload: { type: 'noop', sleepMs: 0 },
        workerId: 'test',
        signal: new AbortController().signal,
        heartbeat: () => true,
        log: silentLogger,
      }),
    ).rejects.toThrow(/handler "render" received a "noop" payload/);
  });
});

describe('poll loop', () => {
  it('drains the queue and stops gracefully', async () => {
    const ids = [
      enqueue(db, { type: 'noop', sleepMs: 0, note: 'a' }).id,
      enqueue(db, { type: 'noop', sleepMs: 0, note: 'b' }).id,
      enqueue(db, { type: 'noop', sleepMs: 0, note: 'c' }).id,
    ];

    const worker = createWorker({ db, config, logger: silentLogger });
    const done = worker.start();

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (ids.every((id) => getJob(db, id)?.status === 'done')) {
          clearInterval(check);
          resolve();
        }
      }, 5);
    });

    worker.stop();
    await done;
    expect(worker.running).toBe(false);
    for (const id of ids) expect(getJob(db, id)?.status).toBe('done');
  });
});

describe('loadWorkerConfig', () => {
  it('uses the documented defaults', () => {
    const loaded = loadWorkerConfig({} as NodeJS.ProcessEnv);
    expect(loaded.pollIntervalMs).toBe(1_500);
    expect(loaded.leaseMs).toBe(30_000);
    expect(loaded.maxAttempts).toBe(3);
    expect(loaded.workerId).toMatch(/-\d+$/);
    expect(loaded.types).toBeUndefined();
  });

  it('reads overrides from the environment', () => {
    const loaded = loadWorkerConfig({
      WORKER_ID: 'render-box',
      WORKER_POLL_INTERVAL_MS: '250',
      WORKER_LEASE_MS: '60000',
      WORKER_JOB_TYPES: 'render, noop',
    } as NodeJS.ProcessEnv);
    expect(loaded.workerId).toBe('render-box');
    expect(loaded.pollIntervalMs).toBe(250);
    expect(loaded.leaseMs).toBe(60_000);
    expect(loaded.types).toEqual(['render', 'noop']);
  });

  it('ignores nonsense values rather than crashing at boot', () => {
    const loaded = loadWorkerConfig({ WORKER_POLL_INTERVAL_MS: 'soon' } as NodeJS.ProcessEnv);
    expect(loaded.pollIntervalMs).toBe(1_500);
  });
});
