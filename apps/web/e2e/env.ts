/**
 * Where the end-to-end run lives, and what it is told about itself.
 *
 * Deliberately free of side effects. Playwright loads the config, the global
 * setup and the global teardown as separate modules, so anything destructive at
 * module scope here would run more than once — and running `rm -rf` on the
 * workspace a second time, after the web server has already opened the database
 * file, leaves the server holding a deleted inode and every page reporting that
 * there is no such table. Creating and removing the directory is globalSetup's
 * job, once, in order.
 */
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(here, '../../..');

/** A world of its own, rebuilt from nothing at the start of every run. */
export const E2E_DIR = path.join(tmpdir(), 'col-e2e');

/** 3300–3309 belong to this suite. */
export const E2E_PORT = Number(process.env['E2E_PORT'] ?? 3303);
export const BASE_URL = `http://127.0.0.1:${E2E_PORT}`;

/**
 * Shared by the web server, the worker and the preparation script, so all three
 * are unambiguously looking at the same database and the same blobs.
 */
export const e2eEnv: Record<string, string> = {
  ...(process.env as Record<string, string>),
  NODE_ENV: 'production',
  DATABASE_URL: `file:${path.join(E2E_DIR, 'e2e.db')}`,
  STORAGE_DIR: path.join(E2E_DIR, 'blobs'),
  SESSION_SECRET: 'e2e-session-secret-not-a-real-one',
  LINK_SECRET: 'e2e-link-secret-not-a-real-one',
  APP_BASE_URL: BASE_URL,
  PORT: String(E2E_PORT),
  // Never a real model, and never a real inbox.
  AI_PROVIDER: 'mock',
  AI_FIXTURES_DIR: path.join(repoRoot, 'fixtures/ai'),
  MAIL_TRANSPORT: 'console',
  // The queue has to move quickly here: the test is waiting on it.
  WORKER_POLL_INTERVAL_MS: '250',
  WORKER_LEASE_MS: '120000',
  LOG_LEVEL: 'warn',
};
