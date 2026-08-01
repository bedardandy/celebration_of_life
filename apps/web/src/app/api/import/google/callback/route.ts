/**
 * Coming back from Google, and going straight on to the picker.
 *
 * Google returns a `code` and the `state` we sent. Both are checked before
 * anything happens: the state must open with our key, must match the cookie the
 * browser that started this was given, and must name a memorial this person
 * organises. Anything else lands on the collect screen with a calm sentence and
 * no import.
 *
 * When it all fits, this exchanges the code for a short-lived token, opens a
 * picker session, queues the import with the token sealed inside it, and sends
 * the person to Google's own picker. The worker then waits for them to finish
 * choosing, which is why nobody has to sit on a loading screen while an aunt
 * scrolls through 2004.
 */
import { NextResponse } from 'next/server';
import {
  createPickerSession,
  exchangeCodeForToken,
  googlePhotosConfig,
  open,
  seal,
  GOOGLE_STATE_PURPOSE,
  GOOGLE_TOKEN_PURPOSE,
  GOOGLE_TOKEN_TTL_MS,
  type GoogleImportState,
} from '@col/core';
import { enqueue } from '@col/db';
import { db } from '@/server/db';
import { currentOrganizer } from '@/server/auth';
import { GOOGLE_STATE_COOKIE } from '../start/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const config = googlePhotosConfig();
  if (!config) return new NextResponse('Not available.', { status: 404 });

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  const cookieState = readCookie(request.headers.get('cookie'), GOOGLE_STATE_COOKIE);
  const opened = open<GoogleImportState>(GOOGLE_STATE_PURPOSE, state);

  // A `state` that did not come from this browser is not an error message worth
  // writing; it is a thing that did not happen.
  if (!opened.ok || !cookieState || cookieState !== state) {
    return home(url, 'google=again');
  }
  const { memorialId } = opened.value;

  if (!code) {
    // The person said no on Google's screen. That is a decision, not a failure.
    return clearState(
      NextResponse.redirect(new URL(`/m/${memorialId}/photos?google=cancelled`, url), 303),
    );
  }

  const organizer = await currentOrganizer(memorialId);
  if (!organizer) return home(url, 'google=again');

  try {
    const token = await exchangeCodeForToken({ config, code });
    const session = await createPickerSession({ accessToken: token.accessToken });

    enqueue(
      db(),
      {
        type: 'import-google-photos',
        memorialId,
        sessionId: session.id,
        sealedToken: seal(GOOGLE_TOKEN_PURPOSE, token, { ttlMs: GOOGLE_TOKEN_TTL_MS }),
        participantId: organizer.participant.id,
      },
      { memorialId, priority: 4 },
    );

    // Off to Google's picker. The job is already waiting for them to finish.
    return clearState(NextResponse.redirect(session.pickerUri, 303));
  } catch {
    return clearState(
      NextResponse.redirect(new URL(`/m/${memorialId}/photos?google=again`, url), 303),
    );
  }
}

function home(url: URL, query: string): NextResponse {
  return clearState(NextResponse.redirect(new URL(`/?${query}`, url), 303));
}

function clearState(response: NextResponse): NextResponse {
  response.cookies.delete(GOOGLE_STATE_COOKIE);
  return response;
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}
