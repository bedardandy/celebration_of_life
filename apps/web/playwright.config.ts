/**
 * The one end-to-end test.
 *
 * It walks the whole product with real clicks, in a real browser, against a
 * real database, a real queue, a real worker and a real ffmpeg render — because
 * every unit test in this repo can pass while the journey is broken, and the
 * journey is the product.
 *
 * Everything it touches is disposable: a temp directory holding its own SQLite
 * file and blob store, made in globalSetup and removed in globalTeardown.
 * Nothing here can see a developer's `data/` directory, and `AI_PROVIDER=mock`
 * means it never reaches a model.
 *
 * Ports 3300–3309 are this suite's. Chromium comes from
 * PLAYWRIGHT_BROWSERS_PATH, which is already set in this environment — never
 * run `playwright install`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { BASE_URL, E2E_PORT, e2eEnv } from './e2e/env';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: path.join(here, 'e2e'),
  // One journey, run once, in order. Parallelism would mean two workers racing
  // for the same render, which is the one thing the queue is not for.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  reporter: [['list']],
  // A draft render of three photographs is the slowest step by a distance.
  timeout: 300_000,
  expect: { timeout: 20_000 },
  globalSetup: path.join(here, 'e2e/global-setup.ts'),
  globalTeardown: path.join(here, 'e2e/global-teardown.ts'),

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    video: 'off',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    // `next start`, not `next dev`: compiling each route on first visit would
    // dominate the wall clock and would not be what production runs anyway.
    command: `node node_modules/next/dist/bin/next start -p ${E2E_PORT} -H 127.0.0.1`,
    cwd: here,
    url: `${BASE_URL}/api/health`,
    env: e2eEnv,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
