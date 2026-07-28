import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | undefined;

/**
 * The repo root, found by walking up to the pnpm workspace manifest.
 *
 * The web app runs with cwd `apps/web`, the worker with `apps/worker`, and
 * `pnpm db:migrate` with `packages/db`. Resolving `DATABASE_URL=file:./data/app.db`
 * against cwd would therefore give each of them a *different, empty* database —
 * a confusing failure that looks like data loss. Relative paths resolve against
 * this instead. Absolute paths are used as given.
 */
export function workspaceRoot(): string {
  if (cached !== undefined) return cached;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 16; i += 1) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      cached = dir;
      return cached;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cached = process.cwd();
  return cached;
}

export function resolveFromRoot(target: string): string {
  return path.isAbsolute(target) ? target : path.resolve(workspaceRoot(), target);
}
