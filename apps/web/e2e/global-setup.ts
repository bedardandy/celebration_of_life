/**
 * What has to exist before the browser opens.
 *
 * A migrated database, the bundled music library seeded into it, and a worker
 * process polling it — the same three things a real deployment needs, which is
 * the point. Both run as child processes under `tsx`, the loader the worker
 * itself uses, rather than being imported into Playwright's own process.
 *
 * The worker is a real process rather than a loop driven from inside the test,
 * because "the queue actually works" is part of what is being proved.
 *
 * This is also the only place the workspace directory is created or destroyed,
 * so it happens exactly once and in a known order.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { E2E_DIR, e2eEnv, repoRoot } from './env';

/** Kept on globalThis so teardown finds it across module instances. */
const WORKER_KEY = '__colE2eWorker';

const TSX = path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs');

export default async function globalSetup(): Promise<void> {
  rmSync(E2E_DIR, { recursive: true, force: true });
  mkdirSync(E2E_DIR, { recursive: true });

  const prepared = spawnSync(
    process.execPath,
    [TSX, path.join(repoRoot, 'apps/web/e2e/prepare.ts')],
    { cwd: repoRoot, env: e2eEnv as NodeJS.ProcessEnv, stdio: ['ignore', 'inherit', 'inherit'] },
  );
  if (prepared.status !== 0) {
    throw new Error(`e2e: preparing the workspace failed (exit ${String(prepared.status)})`);
  }

  const worker: ChildProcess = spawn(
    process.execPath,
    [TSX, path.join(repoRoot, 'apps/worker/src/index.ts')],
    { cwd: repoRoot, env: e2eEnv as NodeJS.ProcessEnv, stdio: ['ignore', 'ignore', 'inherit'] },
  );

  (globalThis as Record<string, unknown>)[WORKER_KEY] = worker;

  worker.on('exit', (code: number | null) => {
    if (code !== 0 && code !== null) {
      process.stderr.write(`[e2e] the worker exited with code ${String(code)}\n`);
    }
  });

  process.stderr.write(`[e2e] workspace: ${E2E_DIR}\n`);
}
