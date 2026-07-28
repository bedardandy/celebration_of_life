/**
 * Reading and writing the session cookie inside Next.
 *
 * All the cryptography lives in @col/core; this file only knows how to reach
 * Next's cookie store. Keeping the split means the auth rules are unit-tested
 * without a request object anywhere near them.
 */
import { cookies } from 'next/headers';
import {
  SESSION_COOKIE,
  decodeSession,
  encodeSession,
  sessionCookieOptions,
  type Session,
} from '@col/core';

/** Short-lived cookie carrying the dev magic link to the screen that shows it. */
export const DEV_LINK_COOKIE = 'col_dev_link';
const DEV_LINK_MAX_AGE_SEC = 600;

export async function readSession(): Promise<Session | undefined> {
  const store = await cookies();
  return decodeSession(store.get(SESSION_COOKIE)?.value);
}

export async function writeSession(session: Session): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, encodeSession(session), sessionCookieOptions());
}

export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

/** Set-Cookie value for route handlers, which build their own response. */
export function sessionSetCookie(session: Session): {
  name: string;
  value: string;
  options: ReturnType<typeof sessionCookieOptions>;
} {
  return { name: SESSION_COOKIE, value: encodeSession(session), options: sessionCookieOptions() };
}

export async function stashDevLink(link: string | undefined): Promise<void> {
  if (!link) return;
  const store = await cookies();
  store.set(DEV_LINK_COOKIE, link, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: DEV_LINK_MAX_AGE_SEC,
  });
}

/** Reads the stashed dev link. Server components cannot clear cookies, so it
 *  simply ages out after ten minutes. */
export async function readDevLink(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(DEV_LINK_COOKIE)?.value;
}
