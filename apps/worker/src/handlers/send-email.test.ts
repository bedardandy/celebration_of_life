/**
 * Sending the queued message, through the queue.
 *
 * The point of the job is not throughput — it is that a mail service being down
 * for ten minutes must not turn into an organiser being unable to get back into
 * their own memorial. So the two things asserted here are: the words are
 * composed from the payload (never carried in it), and a refused send fails the
 * job so the queue tries again.
 *
 * No message leaves this process: the transport is swapped for a spy.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, enqueue, listWhere, jobs, type Db } from '@col/db';
import { setMailTransport, type MailMessage } from '@col/core';
import { runOnce } from '../runner';
import type { WorkerConfig } from '../config';
import type { Logger } from '../log';

const silent: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => silent,
};

const config: WorkerConfig = {
  workerId: 'mail-test',
  pollIntervalMs: 5,
  leaseMs: 30_000,
  maxAttempts: 3,
};

let db: Db;
let sent: MailMessage[];

beforeEach(() => {
  db = createTestDb();
  sent = [];
});

afterEach(() => setMailTransport(undefined));

function spyTransport(fail?: string) {
  setMailTransport({
    name: 'spy',
    send: async (message) => {
      if (fail) throw new Error(fail);
      sent.push(message);
      return { transport: 'spy', delivered: true };
    },
  });
}

function queueLoginEmail() {
  return enqueue(
    db,
    {
      type: 'send-email',
      to: 'anne@example.test',
      subject: 'Your link for Ruth Kelleher',
      template: 'organizer-login',
      data: { decedentName: 'Ruth Kelleher', url: 'https://example.test/auth/tok' },
    },
    { priority: 5, maxAttempts: 5 },
  );
}

describe('the send-email job', () => {
  it('composes the words from the payload and sends them', async () => {
    spyTransport();
    queueLoginEmail();

    const result = await runOnce({ db, config, logger: silent });

    expect(result.status).toBe('done');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('anne@example.test');
    expect(sent[0]?.subject).toBe('Your link for Ruth Kelleher');
    expect(sent[0]?.body).toContain('https://example.test/auth/tok');
    // The prose was never in the queue row; only the facts were.
    expect(JSON.stringify(listWhere(db, jobs)[0]?.payload)).not.toContain(
      'Nothing you have added is lost',
    );
  });

  it('fails the job when the service refuses, so the queue tries again', async () => {
    spyTransport('the mail service refused the message (403)');
    queueLoginEmail();

    const result = await runOnce({ db, config, logger: silent });

    expect(result.status).toBe('retrying');
    const row = listWhere(db, jobs)[0];
    // Still queued for another attempt rather than parked.
    expect(row?.status).toBe('queued');
    expect(row?.lastError).toContain('403');
    expect(sent).toHaveLength(0);
  });
});
