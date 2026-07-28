/**
 * Where photos land.
 *
 * The only authentication is the collection link itself, passed as a token, and
 * the only thing this endpoint does is write bytes and enqueue work. It has to
 * survive a 2016 Android phone on a train: one request per file, no session, no
 * preflight, and a plain <form> POST works exactly as well as Uppy does — the
 * fallback is not a courtesy, it is the same code path.
 */
import { NextResponse } from 'next/server';
import {
  checkUpload,
  recordUpload,
  resolveCollectionToken,
  MAX_FILES_PER_REQUEST,
  UPLOAD_REJECTION_MESSAGE,
} from '@col/core';
import { extensionForMime, normalizeUploadMime } from '@col/media';
import { newId } from '@col/db';
import { blobKeys, getBlobStore } from '@col/storage';
import { db } from '@/server/db';
import {
  batchCookieName,
  contributorFromCookieHeader,
  parseBatch,
  readCookieHeader,
  serializeBatch,
} from '@/server/contributor';

export const dynamic = 'force-dynamic';
// Buffers of photo bytes are not something the edge runtime can hold.
export const runtime = 'nodejs';

type UploadedFile = { id: string; name: string | null; ok: true };
type RejectedFile = { name: string | null; ok: false; reason: string };

function wantsJson(request: Request): boolean {
  const accept = request.headers.get('accept') ?? '';
  return accept.includes('application/json') || !accept.includes('text/html');
}

export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const form = await request.formData().catch(() => undefined);
  if (!form) {
    return NextResponse.json({ error: 'We could not read that upload.' }, { status: 400 });
  }

  const token = String(form.get('token') ?? url.searchParams.get('token') ?? '');
  const resolved = resolveCollectionToken(db(), token);
  if (!resolved.ok) {
    // Deliberately terse: an invalid link should not describe the memorial it
    // failed to open.
    return NextResponse.json({ error: 'This link is no longer active.' }, { status: 403 });
  }
  const context = resolved.context;
  if (!context.canUpload) {
    return NextResponse.json({ error: 'This link cannot add photos.' }, { status: 403 });
  }

  const files = form
    .getAll('files')
    .concat(form.getAll('file'))
    .filter((entry): entry is File => entry instanceof File && entry.size > 0)
    .slice(0, MAX_FILES_PER_REQUEST);

  if (files.length === 0) {
    const empty = { error: 'No photos arrived. It may be worth trying again.' };
    return wantsJson(request)
      ? NextResponse.json(empty, { status: 400 })
      : NextResponse.redirect(new URL(`/c/${token}/add?nothing=1`, url), 303);
  }

  const participant = contributorFromCookieHeader(request.headers.get('cookie'), context);
  const store = getBlobStore();
  const accepted: UploadedFile[] = [];
  const rejected: RejectedFile[] = [];

  for (const file of files) {
    const filename = file.name || null;
    const mime = normalizeUploadMime(file.type, filename ?? undefined);
    const problem = checkUpload({ mime, byteSize: file.size, filename: filename ?? undefined });
    if (problem) {
      rejected.push({ name: filename, ok: false, reason: UPLOAD_REJECTION_MESSAGE[problem] });
      continue;
    }

    const assetId = newId();
    const key = blobKeys.original(context.memorial.id, assetId, extensionForMime(mime));
    const bytes = Buffer.from(await file.arrayBuffer());
    await store.put(key, bytes, mime);

    const { asset } = recordUpload(db(), {
      memorialId: context.memorial.id,
      assetId,
      blobKey: key,
      mime,
      byteSize: bytes.byteLength,
      originalFilename: filename,
      uploadedByParticipantId: participant?.id ?? null,
    });
    accepted.push({ id: asset.id, name: asset.originalFilename, ok: true });
  }

  // Remember the batch so the next screen can ask about these photos and not
  // about the ones this person sent last Tuesday.
  const previous = parseBatch(
    readCookieHeader(request.headers.get('cookie'), batchCookieName(context.token.id)),
  );
  const batch = serializeBatch([...previous, ...accepted.map((a) => a.id)]);

  const response = wantsJson(request)
    ? NextResponse.json(
        {
          added: accepted.length,
          assets: accepted,
          rejected,
          // Where a browser without JavaScript would have been sent next.
          next: `/c/${token}/notes`,
        },
        { status: accepted.length > 0 ? 201 : 400 },
      )
    : redirectAfterUpload(url, token, accepted.length, rejected.length);

  if (accepted.length > 0) {
    response.cookies.set(batchCookieName(context.token.id), batch, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24,
    });
  }
  return response;
}

function redirectAfterUpload(
  url: URL,
  token: string,
  added: number,
  skipped: number,
): NextResponse {
  const destination = new URL(`/c/${token}/notes`, url);
  if (added > 0) destination.searchParams.set('added', String(added));
  if (skipped > 0) destination.searchParams.set('skipped', String(skipped));
  return NextResponse.redirect(destination, 303);
}
