/**
 * ffmpeg / ffprobe process wrappers.
 *
 * ffmpeg on PATH is the product's single system prerequisite. Everything that
 * shells out goes through here so there is exactly one place that knows how the
 * binaries are located, how long they may run, and how their stderr is
 * surfaced. "It wouldn't play at the funeral" is the catastrophic failure mode,
 * so ffprobe verification is a first-class citizen, not an afterthought.
 */
import { spawn } from 'node:child_process';

export const DEFAULT_TIMEOUT_MS = 120_000;
/** Cap captured output so a chatty encode cannot exhaust memory. */
const MAX_CAPTURE_BYTES = 1_000_000;

export type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
  /** Present only when `binaryStdout` was asked for: raw, undecoded bytes. */
  stdoutBuffer?: Buffer;
  durationMs: number;
  command: string;
  args: string[];
};

export type RunOptions = {
  timeoutMs?: number;
  cwd?: string;
  /** Resolve instead of throwing on a non-zero exit code. */
  allowNonZeroExit?: boolean;
  signal?: AbortSignal;
  /** Called with each stderr chunk — ffmpeg reports progress there. */
  onStderr?: (chunk: string) => void;
  /**
   * Keep stdout as bytes rather than decoding it as UTF-8. Needed whenever
   * ffmpeg is piping raw PCM out: decoding samples as text destroys them.
   */
  binaryStdout?: boolean;
  /** Cap on captured stdout. Raw PCM needs far more room than a JSON probe. */
  maxStdoutBytes?: number;
};

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly result: RunResult,
  ) {
    super(message);
    this.name = 'FfmpegError';
  }
}

export class FfmpegMissingError extends Error {
  constructor(binary: string, cause?: unknown) {
    super(
      [
        `Could not run "${binary}".`,
        '',
        'This app needs ffmpeg (and ffprobe) on your PATH to build the tribute video.',
        '',
        '  macOS         brew install ffmpeg',
        '  Debian/Ubuntu sudo apt-get install -y ffmpeg',
        '  Fedora        sudo dnf install -y ffmpeg',
        '  Windows       winget install Gyan.FFmpeg',
        '',
        'Already installed somewhere unusual? Set FFMPEG_PATH and FFPROBE_PATH in .env.',
      ].join('\n'),
    );
    this.name = 'FfmpegMissingError';
    this.cause = cause;
  }
}

export function ffmpegPath(): string {
  return process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
}

export function ffprobePath(): string {
  return process.env.FFPROBE_PATH?.trim() || 'ffprobe';
}

function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  return new Promise<RunResult>((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new FfmpegMissingError(command, err));
      return;
    }

    let stdout = '';
    let stderr = '';
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    const maxStdoutBytes =
      options.maxStdoutBytes ?? (options.binaryStdout ? 512_000_000 : MAX_CAPTURE_BYTES);
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const onAbort = () => child.kill('SIGKILL');
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };

    child.stdout?.on('data', (d: Buffer) => {
      if (options.binaryStdout) {
        if (stdoutBytes + d.byteLength <= maxStdoutBytes) {
          stdoutChunks.push(d);
          stdoutBytes += d.byteLength;
        }
        return;
      }
      if (stdout.length < maxStdoutBytes) stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      const chunk = d.toString('utf8');
      if (stderr.length < MAX_CAPTURE_BYTES) stderr += chunk;
      options.onStderr?.(chunk);
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err.code === 'ENOENT') reject(new FfmpegMissingError(command, err));
      else reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      const result: RunResult = {
        code: code ?? -1,
        stdout,
        stderr,
        ...(options.binaryStdout ? { stdoutBuffer: Buffer.concat(stdoutChunks) } : {}),
        durationMs: Date.now() - startedAt,
        command,
        args,
      };
      if (timedOut) {
        reject(new FfmpegError(`${command} timed out after ${timeoutMs}ms`, result));
        return;
      }
      if (result.code !== 0 && !options.allowNonZeroExit) {
        const tail = stderr.trim().split('\n').slice(-8).join('\n');
        reject(new FfmpegError(`${command} exited with code ${result.code}\n${tail}`, result));
        return;
      }
      resolve(result);
    });
  });
}

export function runFfmpeg(args: string[], options?: RunOptions): Promise<RunResult> {
  return run(ffmpegPath(), args, options);
}

export function runFfprobe(args: string[], options?: RunOptions): Promise<RunResult> {
  return run(ffprobePath(), args, { timeoutMs: 30_000, ...options });
}

/** ffprobe a file and return its parsed JSON metadata. */
export async function probe(filePath: string, options?: RunOptions): Promise<Record<string, any>> {
  const result = await runFfprobe(
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    options,
  );
  return JSON.parse(result.stdout) as Record<string, any>;
}

export type FfmpegCheck = {
  ok: boolean;
  ffmpeg: { path: string; ok: boolean; version?: string };
  ffprobe: { path: string; ok: boolean; version?: string };
  /** Plain-language, actionable text — safe to show a user. */
  message: string;
};

function parseVersion(stdout: string): string | undefined {
  return stdout.split('\n', 1)[0]?.trim() || undefined;
}

/**
 * Probe both binaries. Never throws: callers decide whether a missing ffmpeg is
 * fatal (worker render) or merely reported (health endpoint).
 */
export async function checkFfmpeg(): Promise<FfmpegCheck> {
  const one = async (
    exec: (args: string[], options?: RunOptions) => Promise<RunResult>,
    path: string,
  ) => {
    try {
      const res = await exec(['-version'], { timeoutMs: 10_000 });
      return { path, ok: true, version: parseVersion(res.stdout) };
    } catch {
      return { path, ok: false };
    }
  };

  const [ffmpeg, ffprobe] = await Promise.all([
    one(runFfmpeg, ffmpegPath()),
    one(runFfprobe, ffprobePath()),
  ]);

  const ok = ffmpeg.ok && ffprobe.ok;
  const missing = [!ffmpeg.ok ? 'ffmpeg' : null, !ffprobe.ok ? 'ffprobe' : null].filter(Boolean);

  return {
    ok,
    ffmpeg,
    ffprobe,
    message: ok
      ? `ffmpeg ready (${ffmpeg.version ?? ffmpeg.path})`
      : new FfmpegMissingError(missing.join(' and ')).message,
  };
}
