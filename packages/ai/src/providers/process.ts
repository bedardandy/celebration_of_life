/**
 * Running someone else's CLI, carefully.
 *
 * Both subscription adapters shell out to a binary that may not be installed,
 * may hang, and may print a page of warnings before its actual answer. The
 * rules that keep that survivable live here, once:
 *
 *  - a hard timeout, because a hung `claude -p` in a worker means a family's
 *    interview never comes back
 *  - stderr captured and reported, because "exit code 1" on its own helps nobody
 *  - a single-flight mutex per binary: these CLIs are interactive tools wearing
 *    a batch costume, and two at once is how you get interleaved sessions
 *  - a presence check that never runs the thing, so `ai:doctor` can report a
 *    missing binary instead of crashing on it
 */
import { spawn, spawnSync } from 'node:child_process';

export const DEFAULT_CLI_TIMEOUT_MS = 120_000;

export type RunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
};

export type RunOptions = {
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Written to stdin and then closed. */
  input?: string;
  signal?: AbortSignal;
};

export async function runCommand(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
  const startedAt = Date.now();

  return new Promise<RunResult>((resolve, reject) => {
    let child;
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd ?? process.cwd(),
        env: options.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // A CLI that ignores SIGTERM still has to go.
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref?.();
    }, timeoutMs);
    timer.unref?.();

    const onAbort = () => {
      child.kill('SIGTERM');
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      finish();
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      finish();
      resolve({ code, stdout, stderr, durationMs: Date.now() - startedAt, timedOut });
    });

    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    } else {
      child.stdin?.end();
    }
  });
}

/* -------------------------------------------------------------------------- */
/* presence                                                                    */
/* -------------------------------------------------------------------------- */

const presence = new Map<string, boolean>();

/** Is this binary on PATH? Cached — PATH does not change mid-process. */
export function binaryExists(command: string): boolean {
  const hit = presence.get(command);
  if (hit !== undefined) return hit;
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], {
    stdio: 'ignore',
    timeout: 5_000,
  });
  const found = probe.status === 0;
  presence.set(command, found);
  return found;
}

/** Test hook: forget what we learned about PATH (and any cached CLI probes). */
export function resetProcessCaches(): void {
  presence.clear();
}

/* -------------------------------------------------------------------------- */
/* single flight                                                               */
/* -------------------------------------------------------------------------- */

export type Mutex = <T>(fn: () => Promise<T>) => Promise<T>;

/** Serialises calls. One CLI conversation at a time, per binary. */
export function createMutex(): Mutex {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    // Swallow rejections on the chain itself; the caller still sees them.
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

/** First non-empty line of stderr, for an error message a person can read. */
export function firstStderrLine(stderr: string, max = 300): string {
  const line = stderr
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return '';
  return line.length <= max ? line : `${line.slice(0, max)}…`;
}
