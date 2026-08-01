/**
 * The still frame a video shows before anyone presses play.
 *
 * Made the first time somebody asks for it rather than at render time: most
 * renders are never shared, and a family waiting on a video should not also be
 * waiting on a thumbnail. Once made it is kept in the blob store under the
 * memorial's own prefix, so it is served straight from disk afterwards and a
 * hard delete takes it with everything else.
 *
 * Same door as the video itself: an organiser session or a viewing link. If
 * ffmpeg cannot produce a frame, the answer is 404 and the page falls back to
 * its own quiet placeholder — a missing poster must never break the video.
 */
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractPosterFrame } from '@col/media';
import { getBlobStore } from '@col/storage';
import { authorizeRender } from '@/server/render-access';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ renderJobId: string }> },
): Promise<Response> {
  const { renderJobId } = await params;
  const access = await authorizeRender(request, renderJobId);
  if (!access) {
    return new Response('Not available.', {
      status: 403,
      headers: { 'cache-control': 'no-store' },
    });
  }

  const { job } = access;
  const posterKey = `memorial/${job.memorialId}/poster/${job.id}.jpg`;
  const store = getBlobStore();

  const headers = new Headers({
    'content-type': 'image/jpeg',
    // Private, but worth keeping for the length of a visit: the watch page asks
    // for this on every load and it never changes for a given render.
    'cache-control': 'private, max-age=3600',
    'x-content-type-options': 'nosniff',
  });

  if (!(await store.exists(posterKey))) {
    const made = await makePoster(job.outputBlobKey as string, posterKey);
    if (!made) return new Response('No still frame.', { status: 404 });
  }

  const stream = await store.getStream(posterKey);
  return new Response(Readable.toWeb(stream) as WebReadableStream<Uint8Array> as ReadableStream, {
    headers,
  });
}

async function makePoster(videoKey: string, posterKey: string): Promise<boolean> {
  const store = getBlobStore();
  const scratch = await mkdtemp(path.join(tmpdir(), 'col-poster-'));
  try {
    let videoFile = store.getPath?.(videoKey);
    if (!videoFile) {
      const { createWriteStream } = await import('node:fs');
      const { pipeline } = await import('node:stream/promises');
      videoFile = path.join(scratch, 'video.mp4');
      await pipeline(await store.getStream(videoKey), createWriteStream(videoFile));
    }
    const posterFile = path.join(scratch, 'poster.jpg');
    await extractPosterFrame({ videoFile, outputFile: posterFile });
    const bytes = await readFile(posterFile);
    if (bytes.byteLength === 0) return false;
    await store.put(posterKey, bytes, 'image/jpeg');
    return true;
  } catch {
    // A tribute video with no thumbnail is a small disappointment. A watch page
    // that 500s because ffmpeg was unhappy is not.
    return false;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
