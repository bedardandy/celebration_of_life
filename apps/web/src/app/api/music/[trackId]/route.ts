/**
 * The only way to hear a track.
 *
 * Bundled library music is not secret, but a family's own recording — Grandpa
 * at the piano — absolutely is, and one route that treats both the same way is
 * the only version of this that cannot leak the second kind. So: an organizer
 * session is required, and a family-supplied track is served only to the
 * memorial whose prefix its blob key sits under.
 *
 * Range requests are answered, because a fifteen-second preview in Safari is a
 * range request whether we like it or not.
 */
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { authorizeOrganizer } from '@col/core';
import { getById, musicTracks } from '@col/db';
import { BlobNotFoundError, getBlobStore } from '@col/storage';
import { db } from '@/server/db';
import { readSession } from '@/server/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const forbidden = () =>
  new Response('Not available.', { status: 403, headers: { 'cache-control': 'no-store' } });

export async function GET(
  request: Request,
  { params }: { params: Promise<{ trackId: string }> },
): Promise<Response> {
  const { trackId } = await params;
  const track = getById(db(), musicTracks, trackId);
  if (!track?.blobKey) return forbidden();

  const session = await readSession();
  if (!session) return forbidden();

  // A family recording lives under memorial/{id}/ — only that memorial's
  // organizer may hear it. Library tracks are readable by any signed-in
  // organizer, which is what the picker needs; "signed in" is checked against
  // the session's own memorial so a revoked participant is not still let in.
  const owner = /^memorial\/([^/]+)\//.exec(track.blobKey)?.[1] ?? session.memorialId;
  if (!authorizeOrganizer(db(), session, owner).ok) return forbidden();

  const store = getBlobStore();
  const stat = await store.stat(track.blobKey);
  if (!stat) return new Response('Not found.', { status: 404 });

  const mime = track.blobKey.endsWith('.mp3')
    ? 'audio/mpeg'
    : track.blobKey.endsWith('.wav')
      ? 'audio/wav'
      : track.blobKey.endsWith('.flac')
        ? 'audio/flac'
        : track.blobKey.endsWith('.ogg')
          ? 'audio/ogg'
          : 'audio/mp4';

  const headers = new Headers({
    'content-type': mime,
    'accept-ranges': 'bytes',
    // Private and long-lived: a track's bytes never change, and no shared cache
    // may keep a family's own recording.
    'cache-control': 'private, max-age=3600',
    'x-content-type-options': 'nosniff',
  });

  try {
    const range = parseRange(request.headers.get('range'), stat.byteSize);
    const path = store.getPath?.(track.blobKey);

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
    const stream = await store.getStream(track.blobKey);
    if (request.method === 'HEAD') return new Response(null, { headers });
    return new Response(Readable.toWeb(stream) as WebReadableStream<Uint8Array> as ReadableStream, {
      headers,
    });
  } catch (error) {
    if (error instanceof BlobNotFoundError) return new Response('Not found.', { status: 404 });
    throw error;
  }
}

export const HEAD = GET;

/** `bytes=0-` and `bytes=1000-2000`. Anything odder is served whole. */
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
