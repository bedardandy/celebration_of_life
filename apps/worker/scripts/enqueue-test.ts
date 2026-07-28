/**
 * `pnpm --filter @col/worker enqueue-test` — put one noop job on the queue.
 *
 * The two-command smoke test for the whole queue:
 *   pnpm --filter @col/worker enqueue-test
 *   pnpm --filter @col/worker start      # watch it go to "done", then Ctrl-C
 */
import { countByStatus, enqueue, ensureDatabase, getDb } from '@col/db';

const note = process.argv[2] ?? 'queue smoke test';
const { file } = ensureDatabase(process.env['DATABASE_URL']);
const db = getDb();

const job = enqueue(db, { type: 'noop', sleepMs: 100, note });

// eslint-disable-next-line no-console
console.log(
  [
    `Enqueued noop job ${job.id} (${file})`,
    `Queue: ${JSON.stringify(countByStatus(db))}`,
    'Start the worker to run it:  pnpm --filter @col/worker start',
  ].join('\n'),
);

db.$sqlite.close();
