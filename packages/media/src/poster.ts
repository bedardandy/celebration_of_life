/**
 * The still that sits on a video before anybody presses play.
 *
 * A watch page opens on a black rectangle unless we give it one, and a black
 * rectangle reads as "broken" to somebody who has been sent a link to their
 * mother's tribute. So we pull a frame out of the finished file.
 *
 * A second in, not frame zero: every tribute in this product fades up from
 * black, so frame zero *is* black. One second is past the fade on every preset
 * and still inside the first photograph.
 */
import { runFfmpeg } from './ffmpeg';

/** Far enough in to be past the fade-up, near enough to be the first slide. */
export const POSTER_AT_SEC = 1;

export type PosterFrameInput = {
  videoFile: string;
  outputFile: string;
  /** Seconds into the video. Defaults to just past the fade-up. */
  atSec?: number;
  /** Longest edge, in pixels. Small: this is a placeholder, not a photograph. */
  width?: number;
  signal?: AbortSignal;
};

/**
 * Grab one frame as a JPEG.
 *
 * `-ss` before `-i` seeks by keyframe, which is both fast and inexact — exactly
 * the right trade for a poster frame. If the video turns out to be shorter than
 * the seek (a two-second draft, say), ffmpeg writes nothing and exits cleanly,
 * so we retry from the very beginning rather than leaving the page with no
 * still at all.
 */
export async function extractPosterFrame(input: PosterFrameInput): Promise<string> {
  const atSec = input.atSec ?? POSTER_AT_SEC;
  const width = input.width ?? 1280;

  const attempt = (seek: number) =>
    runFfmpeg(
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        ...(seek > 0 ? ['-ss', String(seek)] : []),
        '-i',
        input.videoFile,
        '-frames:v',
        '1',
        '-vf',
        `scale=${width}:-2:flags=bicubic`,
        '-q:v',
        '4',
        input.outputFile,
      ],
      { timeoutMs: 30_000, ...(input.signal ? { signal: input.signal } : {}) },
    );

  await attempt(atSec);
  const { stat } = await import('node:fs/promises');
  const size = await stat(input.outputFile).then(
    (s) => s.size,
    () => 0,
  );
  if (size === 0) await attempt(0);
  return input.outputFile;
}
