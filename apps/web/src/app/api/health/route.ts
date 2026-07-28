import { checkFfmpeg } from '@col/core';

/** Spawns ffmpeg, so this route needs the Node runtime, not the edge one. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export type HealthResponse = {
  ok: true;
  /** Whether ffmpeg AND ffprobe are usable. Video rendering needs both. */
  ffmpeg: boolean;
  /** Plain-language detail — safe to show a person. */
  ffmpegMessage: string;
};

export async function GET(): Promise<Response> {
  const check = await checkFfmpeg();
  const body: HealthResponse = {
    ok: true,
    ffmpeg: check.ok,
    ffmpegMessage: check.message,
  };
  return Response.json(body, { headers: { 'cache-control': 'no-store' } });
}
