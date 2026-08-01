/**
 * Worker entry point: `pnpm --filter @col/worker start` (or `dev`).
 *
 * Boot order matters. Migrate before anything reads the DB, report ffmpeg
 * before anyone queues a render, then poll. Every failure here prints something
 * a person can act on — this process is the one that runs unattended while a
 * family waits for a video.
 */
import { checkFfmpeg, seedMusicLibrary } from '@col/core';
import { closeDb, ensureDatabase, getDb } from '@col/db';
import { getBlobStore, initBlobStore } from '@col/storage';
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

  // Where blobs live, decided once. Every `getBlobStore()` after this — in a
  // handler, mid-render — is synchronous and gets whatever was chosen here.
  const store = await initBlobStore();
  log.info('blob storage ready', { driver: store.id });

  const db = getDb();

  // The bundled music library, loaded on every boot. Idempotent by slug, so
  // this is a no-op once it has run, and a track that has been fixed or added
  // needs no migration — only a restart.
  try {
    const seeded = await seedMusicLibrary(db, getBlobStore());
    log.info('music library ready', {
      added: seeded.added.length,
      updated: seeded.updated.length,
      unchanged: seeded.unchanged.length,
    });
    for (const problem of seeded.problems) {
      log.warn('music track excluded', { slug: problem.slug, reason: problem.reason });
    }
  } catch (error) {
    // A music problem must never stop photographs being processed.
    log.error('the music library could not be loaded', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

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
