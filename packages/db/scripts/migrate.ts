/** `pnpm db:migrate` — apply committed migrations to DATABASE_URL. */
import { runMigrations } from '../src/migrate';
import { resolveDbPath } from '../src/client';

const url = process.env.DATABASE_URL;
const { file } = runMigrations(url);
// eslint-disable-next-line no-console
console.log(`Migrations applied. Database: ${file} (resolved from ${url ?? 'default'})`);
if (resolveDbPath(url) === ':memory:') {
  // eslint-disable-next-line no-console
  console.warn('DATABASE_URL points at an in-memory database; nothing was persisted.');
}
