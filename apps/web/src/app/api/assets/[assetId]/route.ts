/**
 * The only way to see a photo.
 *
 * There are no public URLs in this product — not obscured ones, not signed ones
 * that outlive a revoked link. Every single read comes through here and is
 * checked against the memorial the caller belongs to: an organiser session, or
 * a live contributor/watch link for that same memorial. Anything else is a 403,
 * including a perfectly valid link belonging to a different family.
 *
 * Caching is aggressive but private: a variant of an asset never changes its
 * bytes, so the browser may keep it forever, and no shared cache may keep it at
 * all.
 */
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { authorizeOrganizer, resolveContributorToken } from '@col/core';
import { assetVariants, eq, getById, listWhere, mediaAssets, memorials } from '@col/db';
import { ENHANCED_VARIANT, VARIANT_NAMES } from '@col/media';
import { BlobNotFoundError, getBlobStore } from '@col/storage';
import { db } from '@/server/db';
import { readSession } from '@/server/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** A year, private, immutable: the bytes behind an id never change. */
const CACHE_CONTROL = 'private, max-age=31536000, immutable';

const forbidden = () =>
  new Response('Not available.', {
    status: 403,
    headers: { 'cache-control': 'no-store' },
  });

export async function GET(
  request: Request,
  { params }: { params: Promise<{ assetId: string }> },
): Promise<Response> {
  const { assetId } = await params;
  const url = new URL(request.url);
  const requested = url.searchParams.get('variant') ?? 'thumb320';

  const asset = getById(db(), mediaAssets, assetId);
  // A missing asset and an asset belonging to someone else look identical from
  // the outside, on purpose.
  if (!asset || asset.deletedAt != null) return forbidden();
  if (!(await mayRead(request, asset.memorialId))) return forbidden();

  const variant = pickVariant(assetId, requested);
  if (!variant) {
    return new Response('That version is not ready yet.', {
      status: 404,
      headers: { 'cache-control': 'no-store' },
    });
  }

  const etag = `"${assetId}-${variant.kind}-${variant.byteSize}"`;
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, {
      status: 304,
      headers: { etag, 'cache-control': CACHE_CONTROL },
    });
  }

  const headers = new Headers({
    'content-type': variant.mime,
    'content-length': String(variant.byteSize),
    'cache-control': CACHE_CONTROL,
    etag,
    // Nothing here should ever be sniffed into something executable.
    'x-content-type-options': 'nosniff',
    'content-disposition': 'inline',
  });

  try {
    const stream = await getBlobStore().getStream(variant.blobKey);
    if (request.method === 'HEAD') return new Response(null, { headers });
    return new Response(Readable.toWeb(stream) as WebReadableStream<Uint8Array> as ReadableStream, {
      headers,
    });
  } catch (error) {
    if (error instanceof BlobNotFoundError) {
      return new Response('That photo is still arriving.', {
        status: 404,
        headers: { 'cache-control': 'no-store' },
      });
    }
    throw error;
  }
}

export const HEAD = GET;

/** Every derivative a screen may ask for, including the opt-in improved copy. */
const SERVABLE = [...VARIANT_NAMES, ENHANCED_VARIANT] as readonly string[];

/** The original is served only when a derived variant was never made (video). */
function pickVariant(assetId: string, requested: string) {
  const rows = listWhere(db(), assetVariants, eq(assetVariants.assetId, assetId));
  if (rows.length === 0) return undefined;
  const wanted = SERVABLE.includes(requested) ? requested : 'thumb320';
  return (
    rows.find((row) => row.kind === wanted) ??
    // Fall back along the ladder rather than showing nothing: a grid that is
    // still ingesting should show the big one small, not a broken frame.
    rows.find((row) => row.kind === 'web1600') ??
    rows.find((row) => row.kind === 'thumb320') ??
    rows[0]
  );
}

/**
 * Two ways in, and both have to name this memorial.
 *
 * The token may come from the query string (a contributor page linking to its
 * own thumbnails) — never from a referrer, and never from a cookie that another
 * site could cause the browser to send.
 */
async function mayRead(request: Request, memorialId: string): Promise<boolean> {
  const session = await readSession();
  if (session && authorizeOrganizer(db(), session, memorialId).ok) return true;

  const token = new URL(request.url).searchParams.get('token');
  if (!token) return false;

  // Contributor links and (from Phase 6) watch links both read photos; an
  // organiser login link does not, which `resolveContributorToken` enforces.
  const resolved = resolveContributorToken(db(), token);
  if (!resolved.ok || resolved.row.memorialId !== memorialId) return false;

  const memorial = getById(db(), memorials, memorialId);
  return memorial != null && memorial.deletedAt == null;
}
