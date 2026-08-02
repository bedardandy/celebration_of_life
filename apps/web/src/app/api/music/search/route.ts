/**
 * Looking a song up, from our machine rather than theirs.
 *
 * The search runs server-side so that the *query* — which is often a dead
 * parent's favourite song, typed at one in the morning — leaves from us rather
 * than from a bereaved family's browser, and so that identical queries are
 * answered from a few minutes of memory instead of asked again. Nothing
 * identifying travels with it: no key, no account, no memorial id.
 *
 * Be honest about what this does not cover: pressing Listen loads the preview,
 * and the artwork beside it, from Apple's CDN in the person's own browser. The
 * alternative is proxying audio we have no business holding even briefly.
 *
 * A signed-in organizer only — not because a song title is a secret, but
 * because an open proxy is an open proxy.
 *
 * This sits beside `/api/music/[trackId]`; "search" is a static segment, so Next
 * matches it here and never as a track id (which is always a UUID anyway).
 */
import { auditionSearch, authorizeOrganizer } from '@col/core';
import { db } from '@/server/db';
import { readSession } from '@/server/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const session = await readSession();
  if (!session || !authorizeOrganizer(db(), session, session.memorialId).ok) {
    return new Response('Not available.', {
      status: 403,
      headers: { 'cache-control': 'no-store' },
    });
  }

  const term = new URL(request.url).searchParams.get('q') ?? '';
  const result = await auditionSearch({ term });

  // Always 200. There is nothing on the other end of this that could use a
  // status code: the screen either lists songs or invites typing, and an error
  // wall in front of a person choosing their mother's funeral music is not an
  // outcome we are willing to ship.
  return Response.json(result, {
    headers: { 'cache-control': 'private, no-store' },
  });
}
