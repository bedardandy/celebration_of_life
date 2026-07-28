import { checkFfmpeg as probeFfmpeg, type FfmpegCheck } from '@col/media';

export type { FfmpegCheck };

let cached: Promise<FfmpegCheck> | undefined;

/**
 * Shared ffmpeg presence check for both the web app and the worker.
 * Memoised: spawning two processes per health-check request would be silly, and
 * ffmpeg does not appear or disappear while the process is running.
 */
export function checkFfmpeg(options: { refresh?: boolean } = {}): Promise<FfmpegCheck> {
  if (options.refresh) cached = undefined;
  cached ??= probeFfmpeg();
  return cached;
}

/** For the worker's boot check: throws with the friendly, actionable message. */
export async function assertFfmpeg(): Promise<FfmpegCheck> {
  const check = await checkFfmpeg({ refresh: true });
  if (!check.ok) throw new Error(check.message);
  return check;
}
