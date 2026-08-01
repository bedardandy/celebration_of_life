/**
 * Watching and downloading the video.
 *
 * There is no public URL for a family's tribute video, ever — not a long random
 * one, not a signed one that outlives a revoked link. Every byte comes through
 * here and is checked, either against the organiser's session or against a
 * private viewing link scoped to that one memorial.
 *
 * The file is served with a dignified name rather than a blob key, because this
 * is the moment the product becomes a file on somebody's desktop and
 * "a7f3c1e9.mp4" is a small indignity at exactly the wrong time.
 *
 * Range requests are answered properly (206 with a Content-Range), which is what
 * lets a download resume on hotel wifi *and* what lets somebody drag the scrub
 * bar on the watch page. A media element that cannot seek looks broken, and the
 * person looking at it has no way to know it is not their fault.
 */
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { deliverableFilename } from '@col/core';
import { BlobNotFoundError, getBlobStore } from '@col/storage';
import { authorizeRender } from '@/server/render-access';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const forbidden = () =>
  new Response('Not available.', { status: 403, headers: { 'cache-control': 'no-store' } });

export async function GET(
  request: Request,
  { params }: { params: Promise<{ renderJobId: string }> },
): Promise<Response> {
  const { renderJobId } = await params;
  const url = new URL(request.url);
  // Playing it and keeping it are different asks, and a viewing link may be
  // allowed one without the other. A download is the default for the organiser
  // (that is what the deliver screen's button is for); `inline=1` is the venue
  // playback screen asking for something to play rather than something to save.
  const wantsDownload =
    url.searchParams.get('download') === '1' ||
    (!url.searchParams.has('watch') && url.searchParams.get('inline') !== '1');

  const access = await authorizeRender(request, renderJobId, { forDownload: wantsDownload });
  if (!access) return forbidden();

  const { job, memorial } = access;
  const filename = deliverableFilename({
    decedentName: memorial.decedentName,
    cut: job.cut,
    preset: job.preset,
  });

  const store = getBlobStore();
  const blobKey = job.outputBlobKey as string;
  const stat = await store.stat(blobKey);
  if (!stat) return new Response('That video is no longer here.', { status: 404 });

  const headers = new Headers({
    'content-type': 'video/mp4',
    'accept-ranges': 'bytes',
    'content-disposition': `${wantsDownload ? 'attachment' : 'inline'}; filename="${filename}"`,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  });

  try {
    const range = parseRange(request.headers.get('range'), stat.byteSize);
    const path = store.getPath?.(blobKey);

    if (range && path) {
      const { createReadStream } = await import('node:fs');
      headers.set('content-range', `bytes ${range.start}-${range.end}/${stat.byteSize}`);
      headers.set('content-length', String(range.end - range.start + 1));
      if (request.method === 'HEAD') return new Response(null, { status: 206, headers });
      const stream = createReadStream(path, { start: range.start, end: range.end });
      return new Response(
        Readable.toWeb(stream) as WebReadableStream<Uint8Array> as ReadableStream,
        { status: 206, headers },
      );
    }

    headers.set('content-length', String(stat.byteSize));
    if (request.method === 'HEAD') return new Response(null, { headers });
    const stream = await store.getStream(blobKey);
    return new Response(Readable.toWeb(stream) as WebReadableStream<Uint8Array> as ReadableStream, {
      headers,
    });
  } catch (error) {
    if (error instanceof BlobNotFoundError) {
      return new Response('That video is no longer here.', { status: 404 });
    }
    throw error;
  }
}

export const HEAD = GET;

function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!match) return undefined;
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0)
    return undefined;
  return { start, end };
}
