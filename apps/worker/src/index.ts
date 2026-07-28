/**
 * Worker entry point: `pnpm --filter @col/worker start` (or `dev`).
 *
 * Boot order matters. Migrate before anything reads the DB, report ffmpeg
 * before anyone queues a render, then poll. Every failure here prints something
 * a person can act on — this process is the one that runs unattended while a
 * family waits for a video.
 */
import { checkFfmpeg } from '@col/core';
import { closeDb, ensureDatabase, getDb } from '@col/db';
import { loadWorkerConfig } from './config';
import { createWorker } from './worker';
import { handlers } from './handlers';
import { log } from './log';

async function main(): Promise<void> {
  const config = loadWorkerConfig();

  const { migrated, file } = ensureDatabase(config.databaseUrl);
  log.info(migrated ? 'database created and migrated' : 'database ready', { file });

  const ffmpeg = await checkFfmpeg();
  if (ffmpeg.ok) {
    log.info('ffmpeg ready', { version: ffmpeg.ffmpeg.version ?? ffmpeg.ffmpeg.path });
  } else {
    // Not fatal: photo, story and queue work all run fine without it. Renders
    // do not, so say so once, clearly, at boot rather than mid-render.
    log.error(`ffmpeg is not available — video rendering will fail.\n${ffmpeg.message}`);
  }

  const db = getDb();
  const worker = createWorker({ db, config });

  log.info('handlers registered', { types: handlers.types().join(',') });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) {
      log.warn(`${signal} again — abandoning the job in flight`);
      worker.abort();
      return;
    }
    shuttingDown = true;
    log.info(`${signal} received — finishing the current job, then stopping`);
    worker.stop();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await worker.start();
  } finally {
    closeDb();
  }
}

main().catch((err: unknown) => {
  log.error('worker failed to start', { error: err instanceof Error ? err.message : String(err) });
  if (err instanceof Error && err.stack) {
    // eslint-disable-next-line no-console
    console.error(err.stack);
  }
  process.exitCode = 1;
});
