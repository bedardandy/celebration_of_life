#!/usr/bin/env node
/**
 * `pnpm start:prod` — the whole product as one process, for one container.
 *
 * The web app and the worker share one SQLite file and one blob directory, so
 * they have to sit on the same machine. Rather than ask an operator to run two
 * services and keep them in step, this supervises both:
 *
 *   1. migrations and the bundled music library, once, before anything serves
 *      (scripts/start-prod-boot.ts — the same functions the worker calls);
 *   2. `next start` and the worker, each restarted if it dies;
 *   3. one SIGTERM forwarded to both, and a wait while the worker finishes the
 *      job it has in hand.
 *
 * Deliberately dependency-free: node's own child_process is enough, and a
 * process supervisor is a bad place to discover that a package has moved.
 *
 * Everything it reads:
 *   PORT                     the web app's port (default 3000)
 *   COL_SHUTDOWN_GRACE_MS    how long a stopping worker gets (default 25000)
 *   COL_SHUTDOWN_HARD_MS     how long after that before SIGKILL (default 10000)
 *   COL_MAX_RESTARTS         crashes in the window before giving up (default 5)
 *   COL_RESTART_WINDOW_MS    that window (default 60000)
 * plus everything the app itself reads — see .env.example.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const GRACE_MS = intFromEnv('COL_SHUTDOWN_GRACE_MS', 25_000);
const HARD_MS = intFromEnv('COL_SHUTDOWN_HARD_MS', 10_000);
const MAX_RESTARTS = intFromEnv('COL_MAX_RESTARTS', 5);
const RESTART_WINDOW_MS = intFromEnv('COL_RESTART_WINDOW_MS', 60_000);
/** Backoff between restarts; the last value repeats. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 20_000];

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// ---------------------------------------------------------------- logging --

/**
 * Two processes into one log, still readable. Chunks arrive split anywhere, so
 * a partial last line is held back until the rest of it turns up.
 */
function prefixer(prefix, out) {
  let rest = '';
  return {
    write(chunk) {
      const lines = (rest + chunk.toString()).split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) out.write(`${prefix} ${line}\n`);
    },
    flush() {
      if (rest !== '') {
        out.write(`${prefix} ${rest}\n`);
        rest = '';
      }
    },
  };
}

function say(line) {
  process.stdout.write(`[start] ${line}\n`);
}

function complain(line) {
  process.stderr.write(`[start] ${line}\n`);
}

// ------------------------------------------------------- finding the bits --

/**
 * A file that must exist, tried by package resolution first and by its usual
 * place second. Both are legitimate: pnpm's isolated layout resolves cleanly,
 * and a flattened or copied install may not.
 */
function locate(what, { from, request, fallbacks = [] }) {
  if (from && request) {
    try {
      const resolved = createRequire(path.join(root, from)).resolve(request);
      if (existsSync(resolved)) return resolved;
    } catch {
      // Fall through to the plain paths.
    }
  }
  for (const candidate of fallbacks) {
    const full = path.join(root, candidate);
    if (existsSync(full)) return full;
  }
  throw new Error(
    `Could not find ${what}. This build looks incomplete — run \`pnpm install\` and \`pnpm build\`.`,
  );
}

const TSX_CLI = () =>
  locate('tsx (the loader the worker runs under)', {
    from: 'apps/worker/package.json',
    request: 'tsx/dist/cli.mjs',
    fallbacks: ['apps/worker/node_modules/tsx/dist/cli.mjs', 'node_modules/tsx/dist/cli.mjs'],
  });

const NEXT_CLI = () =>
  locate('the Next.js command', {
    from: 'apps/web/package.json',
    request: 'next/dist/bin/next',
    fallbacks: ['apps/web/node_modules/next/dist/bin/next', 'node_modules/next/dist/bin/next'],
  });

/**
 * Where better-sqlite3 and sharp actually live, as directories to search.
 *
 * `next.config.ts` keeps both native modules out of the server bundle on
 * purpose (bundling a .node addon breaks its binding lookup), so the built
 * output calls `require('better-sqlite3')` from inside `apps/web/.next/server`.
 * Under pnpm's isolated layout nothing on that path holds them — they belong to
 * `@col/db` and `@col/media` — and the first request fails with
 * MODULE_NOT_FOUND. Resolving them from the packages that own them and handing
 * the directories to the web process as NODE_PATH is the fix that needs no
 * change to how the repo installs.
 */
function nativeModuleSearchPaths() {
  const owners = [
    ['better-sqlite3', 'packages/db/package.json'],
    ['sharp', 'packages/media/package.json'],
  ];
  const dirs = [];
  for (const [request, from] of owners) {
    let resolved;
    try {
      resolved = createRequire(path.join(root, from)).resolve(request);
    } catch {
      continue; // Optional at boot; the app reports its own absence far better.
    }
    const marker = resolved.lastIndexOf(`${path.sep}node_modules${path.sep}`);
    if (marker === -1) continue;
    const dir = resolved.slice(0, marker + `${path.sep}node_modules`.length);
    if (!dirs.includes(dir)) dirs.push(dir);
  }
  return dirs;
}

// ------------------------------------------------------------ preflight ----

process.env.NODE_ENV ??= 'production';

if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET?.trim()) {
  complain('SESSION_SECRET is not set, so this will not start.');
  complain('Make one with:  openssl rand -base64 48');
  complain('See docs/deploy.md — LINK_SECRET and APP_BASE_URL are set at the same time.');
  process.exit(1);
}

// ------------------------------------------------------ the boot-time work --

/** The boot child, so that a SIGTERM during migrations is not ignored. */
let booting;

/** Migrations and the music library, to completion, before anything serves. */
function runBoot() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [TSX_CLI(), path.join(root, 'scripts/start-prod-boot.ts')],
      { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    booting = child;
    const out = prefixer('[boot]', process.stdout);
    const err = prefixer('[boot]', process.stderr);
    child.stdout.on('data', (c) => out.write(c));
    child.stderr.on('data', (c) => err.write(c));
    child.on('error', (error) => {
      booting = undefined;
      reject(error);
    });
    child.on('exit', (code, signal) => {
      booting = undefined;
      out.flush();
      err.flush();
      if (code === 0) resolve();
      else reject(new Error(`preparing the database failed (${signal ?? `exit ${code}`})`));
    });
  });
}

// ---------------------------------------------------------- the children ---

let shuttingDown = false;
let exitCode = 0;
const children = [];

function start(child) {
  const proc = spawn(process.execPath, child.args(), {
    cwd: child.cwd,
    env: child.env(),
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group: signals reach it only because we send them, and a
    // hard kill can take its grandchildren (Chromium) with it.
    detached: true,
  });
  child.proc = proc;

  const out = prefixer(child.prefix, process.stdout);
  const err = prefixer(child.prefix, process.stderr);
  proc.stdout.on('data', (c) => out.write(c));
  proc.stderr.on('data', (c) => err.write(c));

  // 'error' and 'exit' can both arrive for one failed spawn; count it once.
  let counted = false;
  const gone = (code, signal) => {
    if (counted) return;
    counted = true;
    out.flush();
    err.flush();
    child.proc = undefined;
    onChildGone(child, code, signal);
  };

  proc.on('error', (error) => {
    complain(`${child.name} could not be started: ${error.message}`);
    gone(null, null);
  });
  proc.on('exit', (code, signal) => gone(code, signal));

  say(`${child.name} started (pid ${proc.pid})`);
}

function onChildGone(child, code, signal) {
  const how = signal ? `on ${signal}` : `with code ${code}`;
  if (shuttingDown) {
    say(`${child.name} stopped ${how}`);
    if (children.every((c) => !c.proc)) finish();
    return;
  }

  // Neither child is supposed to end on its own, so a clean exit is still a
  // crash as far as this is concerned.
  const now = Date.now();
  child.crashes = child.crashes.filter((at) => now - at < RESTART_WINDOW_MS);
  child.crashes.push(now);

  if (child.crashes.length > MAX_RESTARTS) {
    complain(`${child.name} has stopped ${child.crashes.length} times in a row (${how}).`);
    complain('Stopping everything so the platform restarts the whole container.');
    exitCode = 1;
    stopEverything();
    return;
  }

  const wait = BACKOFF_MS[Math.min(child.crashes.length - 1, BACKOFF_MS.length - 1)];
  complain(`${child.name} stopped ${how} — starting it again in ${wait}ms`);
  child.timer = setTimeout(() => {
    child.timer = undefined;
    if (!shuttingDown) start(child);
  }, wait);
}

// --------------------------------------------------------------- stopping --

let finished = false;

function finish() {
  if (finished) return;
  finished = true;
  say(exitCode === 0 ? 'stopped' : 'stopped after a problem');
  process.exit(exitCode);
}

function signalChild(child, signal) {
  if (!child.proc?.pid) return;
  try {
    // Negative pid: the child and anything it spawned.
    process.kill(-child.proc.pid, signal);
  } catch {
    try {
      child.proc.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

/**
 * The polite stop, then the impolite one.
 *
 * The worker's first SIGTERM means "finish the job you are holding, then
 * stop" — which for a render can be a long time — and its second means "put it
 * down, the lease will be reclaimed". So: SIGTERM, wait the grace, SIGTERM
 * again, wait a little, SIGKILL. A render abandoned this way is requeued by the
 * next worker that starts, because its lease expires.
 */
function stopEverything() {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children) {
    if (child.timer) clearTimeout(child.timer);
    child.timer = undefined;
  }
  if (booting) {
    // Migrations are quick; a half-applied one is not a thing drizzle leaves
    // behind, and the next boot re-runs whatever did not finish.
    try {
      booting.kill('SIGTERM');
    } catch {
      // Already gone.
    }
  }

  const alive = () => children.filter((c) => c.proc);
  if (alive().length === 0) {
    finish();
    return;
  }

  say('stopping — the worker will finish the job it has in hand');
  for (const child of alive()) signalChild(child, 'SIGTERM');

  setTimeout(() => {
    for (const child of alive()) {
      complain(`${child.name} is still going — asking again, which abandons the job in flight`);
      signalChild(child, 'SIGTERM');
    }
    setTimeout(() => {
      for (const child of alive()) {
        complain(`${child.name} did not stop; ending it`);
        signalChild(child, 'SIGKILL');
      }
      setTimeout(finish, 1_000).unref();
    }, HARD_MS).unref();
  }, GRACE_MS).unref();
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    say(`${signal} received`);
    stopEverything();
  });
}

// ------------------------------------------------------------------ go -----

async function main() {
  const port = process.env.PORT?.trim() || '3000';

  children.push(
    {
      name: 'the web app',
      prefix: '[web]',
      cwd: path.join(root, 'apps/web'),
      crashes: [],
      args: () => [NEXT_CLI(), 'start'],
      env: () => {
        const searchPaths = nativeModuleSearchPaths();
        const existing = process.env.NODE_PATH;
        return {
          ...process.env,
          PORT: port,
          NODE_PATH: [...searchPaths, ...(existing ? [existing] : [])].join(path.delimiter),
        };
      },
    },
    {
      name: 'the worker',
      prefix: '[worker]',
      cwd: root,
      crashes: [],
      args: () => [TSX_CLI(), path.join(root, 'apps/worker/src/index.ts')],
      env: () => ({ ...process.env }),
    },
  );

  say(`preparing ${process.env.DATABASE_URL ?? 'the default database'}`);
  await runBoot();
  if (shuttingDown) return;

  for (const child of children) start(child);
  say(`the web app is on port ${port}; the worker is polling`);
}

main().catch((error) => {
  complain(error instanceof Error ? error.message : String(error));
  exitCode = 1;
  stopEverything();
});
