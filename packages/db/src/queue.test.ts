import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from './client';
import { createTestDb } from './testing';
import {
  backoffMs,
  cancel,
  claimNext,
  complete,
  countByStatus,
  enqueue,
  fail,
  getJob,
  heartbeat,
  jobPayload,
  reclaimExpired,
} from './queue';

let db: Db;

beforeEach(() => {
  db = createTestDb();
});
afterEach(() => {
  db.$sqlite.close();
});

describe('job queue', () => {
  it('enqueue → claim → complete', () => {
    const queued = enqueue(db, { type: 'noop', sleepMs: 5 });
    expect(queued.status).toBe('queued');
    expect(queued.attempts).toBe(0);

    const claimed = claimNext(db, { workerId: 'w1' });
    expect(claimed?.id).toBe(queued.id);
    expect(claimed?.status).toBe('running');
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.lockedBy).toBe('w1');
    expect(claimed?.leaseExpiresAt).toBeGreaterThan(Date.now() - 1000);

    const done = complete(db, queued.id, { ok: true });
    expect(done?.status).toBe('done');
    expect(done?.result).toEqual({ ok: true });
    expect(done?.finishedAt).toBeTypeOf('number');

    expect(countByStatus(db)).toEqual({ done: 1 });
  });

  it('validates the payload at enqueue time', () => {
    expect(() => enqueue(db, { type: 'noop', sleepMs: -1 } as never)).toThrow();
    expect(() => enqueue(db, { type: 'nope' } as never)).toThrow();
  });

  it('applies payload defaults and parses back out of the row', () => {
    const row = enqueue(db, { type: 'noop' } as never);
    expect(jobPayload(row)).toEqual({ type: 'noop', sleepMs: 100 });
  });

  it('never hands the same job to two workers', () => {
    enqueue(db, { type: 'noop' } as never);
    const a = claimNext(db, { workerId: 'w1' });
    const b = claimNext(db, { workerId: 'w2' });
    expect(a).toBeDefined();
    expect(b).toBeUndefined();
  });

  it('returns undefined when the queue is empty', () => {
    expect(claimNext(db, { workerId: 'w1' })).toBeUndefined();
  });

  it('respects runAfter (delayed jobs are not claimable yet)', () => {
    enqueue(db, { type: 'noop' } as never, { delayMs: 60_000 });
    expect(claimNext(db, { workerId: 'w1' })).toBeUndefined();
    expect(claimNext(db, { workerId: 'w1', now: Date.now() + 61_000 })).toBeDefined();
  });

  it('claims higher priority first, then oldest runAfter', () => {
    const low = enqueue(db, { type: 'noop', note: 'low' } as never, { priority: 0 });
    const high = enqueue(db, { type: 'noop', note: 'high' } as never, { priority: 10 });
    expect(claimNext(db, { workerId: 'w1' })?.id).toBe(high.id);
    expect(claimNext(db, { workerId: 'w1' })?.id).toBe(low.id);
  });

  it('filters by job type', () => {
    const noop = enqueue(db, { type: 'noop' } as never);
    enqueue(db, {
      type: 'purge-blobs',
      memorialId: 'm1',
      prefix: 'memorial/m1/',
    });
    const claimed = claimNext(db, { workerId: 'w1', types: ['noop'] });
    expect(claimed?.id).toBe(noop.id);
  });

  it('backs off and retries, then gives up at maxAttempts', () => {
    const job = enqueue(db, { type: 'noop' } as never, { maxAttempts: 2 });

    const first = claimNext(db, { workerId: 'w1' })!;
    const r1 = fail(db, first, new Error('boom'));
    expect(r1.retrying).toBe(true);
    expect(r1.row?.status).toBe('queued');
    expect(r1.row?.lastError).toBe('boom');
    expect(r1.runAfter).toBeGreaterThan(Date.now());

    // Not claimable until the backoff elapses.
    expect(claimNext(db, { workerId: 'w1' })).toBeUndefined();

    const second = claimNext(db, { workerId: 'w1', now: Date.now() + 10_000 })!;
    expect(second.attempts).toBe(2);
    const r2 = fail(db, second, new Error('boom again'));
    expect(r2.retrying).toBe(false);
    expect(r2.row?.status).toBe('failed');
    expect(getJob(db, job.id)?.lastError).toBe('boom again');
  });

  it('backoff grows exponentially and is capped', () => {
    expect(backoffMs(1)).toBe(1_000);
    expect(backoffMs(2)).toBe(2_000);
    expect(backoffMs(3)).toBe(4_000);
    expect(backoffMs(50)).toBe(300_000);
  });

  it('reclaims jobs whose lease expired (worker crash)', () => {
    enqueue(db, { type: 'noop' } as never);
    const claimed = claimNext(db, { workerId: 'crashed', leaseMs: 1 })!;
    expect(claimed.status).toBe('running');

    expect(reclaimExpired(db, Date.now() + 5_000)).toBe(1);
    const requeued = getJob(db, claimed.id);
    expect(requeued?.status).toBe('queued');
    expect(requeued?.lockedBy).toBeNull();

    // …and claimNext reclaims implicitly too.
    const again = claimNext(db, { workerId: 'w2' });
    expect(again?.lockedBy).toBe('w2');
  });

  it('heartbeat extends the lease only for the owning worker', () => {
    enqueue(db, { type: 'noop' } as never);
    const claimed = claimNext(db, { workerId: 'w1', leaseMs: 1_000 })!;
    expect(heartbeat(db, claimed.id, 'w2')).toBe(false);
    expect(heartbeat(db, claimed.id, 'w1', 60_000)).toBe(true);
    expect(getJob(db, claimed.id)!.leaseExpiresAt!).toBeGreaterThan(
      claimed.leaseExpiresAt as number,
    );
  });

  it('cancels a queued job', () => {
    const job = enqueue(db, { type: 'noop' } as never);
    expect(cancel(db, job.id)?.status).toBe('cancelled');
    expect(claimNext(db, { workerId: 'w1' })).toBeUndefined();
  });
});
