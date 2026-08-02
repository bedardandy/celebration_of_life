/**
 * What has to be true before the web app serves a page: a migrated database and
 * the bundled music library in it.
 *
 * Run by `scripts/start-prod.mjs` under tsx, once, before either child starts.
 * It calls the same functions the worker and `pnpm db:migrate` call rather than
 * repeating what they do — `runMigrations` because it applies everything
 * pending (`ensureDatabase` only creates a database that is missing, which is
 * the wrong shape for an upgrade), and `seedMusicLibrary` because it is
 * idempotent by slug and a fixed or added track then needs only a restart.
 *
 * Both are safe to run on every boot, which is the point: a deploy is a
 * restart, and nobody has to remember a migration step at eleven at night.
 */
import { seedMusicLibrary } from '../packages/core/src/index';
import { closeDb, getDb, runMigrations } from '../packages/db/src/index';
import { initBlobStore } from '../packages/storage/src/index';

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<void> {
  const { file } = runMigrations(process.env['DATABASE_URL']);
  say(`database ready: ${file}`);

  // Chosen once, here as well, because seeding writes the audio into it.
  const store = await initBlobStore();
  say(`blob storage ready: ${store.id}`);

  try {
    const seeded = await seedMusicLibrary(getDb(), store);
    say(
      `music library ready: ${seeded.added.length} added, ${seeded.updated.length} updated, ` +
        `${seeded.unchanged.length} already there`,
    );
    for (const problem of seeded.problems) {
      process.stderr.write(`music track excluded: ${problem.slug} — ${problem.reason}\n`);
    }
    if (seeded.added.length + seeded.updated.length + seeded.unchanged.length === 0) {
      // Not fatal. Everything except the music picker works without it, and a
      // family with no music is better served than a container that will not
      // start.
      process.stderr.write(
        'No music was found in content/music-library. Everything else still works.\n',
      );
    }
  } catch (error) {
    // A music problem must never stop photographs being processed.
    process.stderr.write(
      `the music library could not be loaded: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }

  closeDb();
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
