/**
 * Redeeming a magic link.
 *
 * The link is exchanged, once, for a session cookie and a redirect. On failure
 * nobody sees a stack trace or the word "unauthorised" — they are sent to the
 * one page that can actually help, which asks for their email and sends a new
 * link.
 *
 * A redirect rather than a rendered page matters here: the token is in the URL,
 * and this way it does not linger in the address bar or in the referrer of
 * every asset the next page loads.
 */
import { NextResponse } from 'next/server';
import { getById, memorials, participants } from '@col/db';
import { redeemToken, resumeIntakeStep, touchParticipant, type TokenRejection } from '@col/core';
import { db } from '@/server/db';
import { sessionSetCookie } from '@/server/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  const now = Date.now();

  const result = redeemToken(db(), token, { now, kind: 'organizer-login' });
  if (!result.ok) {
    return NextResponse.redirect(new URL(resumePathFor(result.reason), request.url));
  }

  const participantId = result.row.participantId;
  const participant = participantId ? getById(db(), participants, participantId) : undefined;
  const memorial = participant ? getById(db(), memorials, participant.memorialId) : undefined;

  if (!participant || participant.revokedAt != null || !memorial || memorial.deletedAt != null) {
    return NextResponse.redirect(new URL('/resume?reason=signed-out', request.url));
  }

  touchParticipant(db(), participant.id, now);

  // Someone who closed the tab halfway through the questions lands back on the
  // question they were looking at, not at the beginning and not on a summary.
  const resumeStep = resumeIntakeStep(memorial);
  const destination = resumeStep ? `/m/${memorial.id}/intake/${resumeStep}` : `/m/${memorial.id}`;

  const response = NextResponse.redirect(new URL(destination, request.url));
  const cookie = sessionSetCookie({
    participantId: participant.id,
    memorialId: participant.memorialId,
    role: participant.role,
    issuedAt: now,
  });
  response.cookies.set(cookie.name, cookie.value, cookie.options);
  return response;
}

function resumePathFor(reason: TokenRejection): string {
  return reason === 'already-used' ? '/resume?reason=link-used' : '/resume?reason=signed-out';
}
