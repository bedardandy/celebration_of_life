/**
 * `pnpm music:seed` — load content/music-library into the database.
 *
 * The worker does this at boot, so this script is for the case where the web
 * app is being run on its own (the music picker reads `music_tracks`, not the
 * directory) and for checking, after `pnpm music:build`, that every track's
 * metadata actually parses.
 *
 * Idempotent: safe to run as often as you like.
 */
/* eslint-disable no-console */
import { seedMusicLibrary, loadMusicLibrary } from '../packages/core/src/index';
import { ensureDatabase, getDb } from '../packages/db/src/index';
import { getBlobStore } from '../packages/storage/src/index';

async function main(): Promise<void> {
  const library = loadMusicLibrary();
  console.log(`${library.tracks.length} tracks on disk.`);

  ensureDatabase();
  const result = await seedMusicLibrary(getDb(), getBlobStore(), { library });

  for (const slug of result.added) console.log(`  + ${slug}`);
  for (const slug of result.updated) console.log(`  ~ ${slug}`);
  for (const slug of result.unchanged) console.log(`  = ${slug}`);
  for (const problem of result.problems) {
    console.warn(`  ! ${problem.slug}: ${problem.reason}`);
  }

  console.log(
    `\n${result.added.length} added, ${result.updated.length} updated, ` +
      `${result.unchanged.length} unchanged, ${result.problems.length} skipped.`,
  );
  if (library.tracks.length === 0) {
    console.warn('\nNo audio found. Run `pnpm music:build` to generate the library.');
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
