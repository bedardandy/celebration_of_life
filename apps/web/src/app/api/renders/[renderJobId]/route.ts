/**
 * Downloading the video.
 *
 * There is no public URL for a family's tribute video, ever — not a long random
 * one, not a signed one that outlives a revoked link. Every download comes
 * through here and is checked against the organizer session for that memorial.
 *
 * The file is served with a dignified name rather than a blob key, because this
 * is the moment the product becomes a file on somebody's desktop and
 * "a7f3c1e9.mp4" is a small indignity at exactly the wrong time. Range requests
 * are answered so a browser can resume a download that dropped on hotel wifi.
 */
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { authorizeOrganizer, deliverableFilename } from '@col/core';
import { getById, memorials, renderJobs } from '@col/db';
import { BlobNotFoundError, getBlobStore } from '@col/storage';
import { db } from '@/server/db';
import { readSession } from '@/server/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const forbidden = () =>
  new Response('Not available.', { status: 403, headers: { 'cache-control': 'no-store' } });

export async function GET(
  request: Request,
  { params }: { params: Promise<{ renderJobId: string }> },
): Promise<Response> {
  const { renderJobId } = await params;

  const job = getById(db(), renderJobs, renderJobId);
  // A render belonging to another family and a render that does not exist look
  // identical from out here, deliberately.
  if (!job?.outputBlobKey || job.status !== 'done') return forbidden();

  const session = await readSession();
  if (!session || !authorizeOrganizer(db(), session, job.memorialId).ok) return forbidden();

  const memorial = getById(db(), memorials, job.memorialId);
  if (!memorial || memorial.deletedAt != null) return forbidden();

  const filename = deliverableFilename({
    decedentName: memorial.decedentName,
    cut: job.cut,
    preset: job.preset,
  });

  const store = getBlobStore();
  const stat = await store.stat(job.outputBlobKey);
  if (!stat) return new Response('That video is no longer here.', { status: 404 });

  const headers = new Headers({
    'content-type': 'video/mp4',
    'accept-ranges': 'bytes',
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  });

  try {
    const range = parseRange(request.headers.get('range'), stat.byteSize);
    const path = store.getPath?.(job.outputBlobKey);

    if (range && path) {
      const { createReadStream } = await import('node:fs');
      headers.set('content-range', `bytes ${range.start}-${range.end}/${stat.byteSize}`);
      headers.set('content-length', String(range.end - range.start + 1));
      const stream = createReadStream(path, { start: range.start, end: range.end });
      return new Response(
        Readable.toWeb(stream) as WebReadableStream<Uint8Array> as ReadableStream,
        { status: 206, headers },
      );
    }

    headers.set('content-length', String(stat.byteSize));
    if (request.method === 'HEAD') return new Response(null, { headers });
    const stream = await store.getStream(job.outputBlobKey);
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
