import { defineConfig } from 'drizzle-kit';

/**
 * SQLite in dev; the schema deliberately sticks to Postgres-portable
 * conventions (text UUIDv7 PKs, integer epoch-ms timestamps, JSON as text)
 * so the dialect can be swapped later without a data model rewrite.
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: (process.env.DATABASE_URL ?? 'file:./data/app.db').replace(/^file:/, ''),
  },
  strict: true,
  verbose: true,
});
