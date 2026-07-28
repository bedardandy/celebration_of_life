import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | undefined;

/**
 * The repo root, found by walking up to the pnpm workspace manifest.
 *
 * Same reasoning as `@col/db`'s copy (and deliberately duplicated rather than
 * making the storage layer depend on the database layer): the web app, the
 * worker and the CLI all run from different working directories, and resolving
 * `STORAGE_DIR=./data/blobs` against cwd would scatter a family's photos across
 * three directories.
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
