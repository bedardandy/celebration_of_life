/**
 * Everything the journey needs to exist before the browser opens.
 *
 * Run through `tsx`, in its own process, rather than imported by Playwright's
 * config: the workspace packages are published as TypeScript source and are
 * loaded by tsx (worker) or Next (web) everywhere else, and Playwright's own
 * loader resolves a couple of their dependencies differently. Using the same
 * loader the worker uses keeps this honest.
 *
 * It reads its settings from the environment the config already assembled.
 */
import { closeDb, ensureDatabase, getDb } from '@col/db';
import { seedMusicLibrary } from '@col/core';
import { initBlobStore } from '@col/storage';

async function main(): Promise<void> {
  const { file } = ensureDatabase(process.env['DATABASE_URL']);
  if (!file) throw new Error('e2e: no database file was created');

  const store = await initBlobStore();
  const seeded = await seedMusicLibrary(getDb(), store);
  if (seeded.added.length + seeded.unchanged.length + seeded.updated.length === 0) {
    throw new Error('e2e: the music library is empty — run `pnpm music:build` first');
  }
  closeDb();

  process.stderr.write(`[e2e] database ${file}, ${seeded.added.length} tracks seeded\n`);
}

await main();
