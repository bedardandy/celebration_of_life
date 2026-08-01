/**
 * Step one of bringing photographs over from Google Photos.
 *
 * This route exists only when `GOOGLE_OAUTH_CLIENT_ID` and
 * `GOOGLE_OAUTH_CLIENT_SECRET` are set. Without them it answers 404 — the same
 * answer as a route that was never written — because a half-configured
 * integration that fails at Google's end with a stack trace is worse than one
 * that is simply not offered.
 *
 * What travels to Google and back is a sealed statement of which memorial this
 * is for. It is encrypted with a key derived from `SESSION_SECRET`, it lasts
 * ten minutes, and it also lives in a cookie so that a `state` handed back by
 * anybody other than the browser that started this goes nowhere.
 */
import { NextResponse } from 'next/server';
import {
  authorizeUrl,
  googlePhotosConfig,
  seal,
  GOOGLE_STATE_PURPOSE,
  GOOGLE_STATE_TTL_MS,
  type GoogleImportState,
} from '@col/core';
import { requireOrganizer } from '@/server/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GOOGLE_STATE_COOKIE = 'col_google_state';

export async function POST(request: Request): Promise<Response> {
  const config = googlePhotosConfig();
  if (!config) return new NextResponse('Not available.', { status: 404 });

  const form = await request.formData().catch(() => undefined);
  const memorialId = String(form?.get('memorialId') ?? '');
  if (!memorialId) return new NextResponse('Not available.', { status: 404 });

  // Redirects to the sign-in screen if this is not their memorial.
  const { participant } = await requireOrganizer(memorialId);

  const nonce = crypto.randomUUID();
  const state = seal<GoogleImportState>(
    GOOGLE_STATE_PURPOSE,
    { memorialId, participantId: participant.id, nonce },
    { ttlMs: GOOGLE_STATE_TTL_MS },
  );

  const response = NextResponse.redirect(authorizeUrl(config, state), 303);
  response.cookies.set(GOOGLE_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env['NODE_ENV'] === 'production',
    maxAge: GOOGLE_STATE_TTL_MS / 1000,
  });
  return response;
}
