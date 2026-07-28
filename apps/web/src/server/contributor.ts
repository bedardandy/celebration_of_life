/**
 * The contributor side of the door.
 *
 * A contributor has no account and no session in the usual sense: the URL is
 * the credential. What we do keep in a cookie is who they said they were, so
 * the second batch of photos carries the same name as the first — and that
 * cookie grants nothing on its own. If it names somebody from another memorial,
 * or somebody who no longer exists, the photos simply arrive unattributed.
 */
import { cookies } from 'next/headers';
import {
  contributorForMemorial,
  resolveCollectionToken,
  type ContributorContext,
  type ContributorResolution,
} from '@col/core';
import type { Participant } from '@col/db';
import { db } from './db';

/** Scoped per token so two links in one browser do not borrow each other's name. */
export function contributorCookieName(tokenId: string): string {
  return `col_c_${tokenId.replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}`;
}

const CONTRIBUTOR_COOKIE_MAX_AGE_SEC = 90 * 24 * 60 * 60;

export function resolveToken(token: string): ContributorResolution {
  return resolveCollectionToken(db(), token);
}

export async function rememberContributor(tokenId: string, participantId: string): Promise<void> {
  const store = await cookies();
  store.set(contributorCookieName(tokenId), participantId, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: CONTRIBUTOR_COOKIE_MAX_AGE_SEC,
  });
}

export async function readContributorCookie(tokenId: string): Promise<string | undefined> {
  const store = await cookies();
  return store.get(contributorCookieName(tokenId))?.value;
}

/**
 * Who is uploading, as far as we can tell. The token's own participant (a
 * personal ask) wins; otherwise the name they typed on the way in; otherwise
 * nobody, which is fine — an unattributed photo is better than no photo.
 */
export async function currentContributor(
  context: ContributorContext,
): Promise<Participant | undefined> {
  if (context.participant) return context.participant;
  const remembered = await readContributorCookie(context.token.id);
  return contributorForMemorial(db(), context.memorial.id, remembered);
}

/* -------------------------------------------------------------------------- */
/* the batch just uploaded                                                     */
/* -------------------------------------------------------------------------- */

/**
 * "Where or when was this?" is asked about the photos somebody has *just* sent,
 * which means the notes page has to know which ones those were — including for
 * a contributor who never typed a name and for a browser with no JavaScript. A
 * short cookie is the smallest thing that works in both cases.
 */
export function batchCookieName(tokenId: string): string {
  return `col_b_${tokenId.replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}`;
}

/** Enough photos to ask about without turning the page into a form to dread. */
export const MAX_BATCH_REMEMBERED = 12;

export function parseBatch(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((id) => id.trim())
    .filter((id) => /^[A-Za-z0-9-]{6,64}$/.test(id))
    .slice(0, MAX_BATCH_REMEMBERED);
}

export function serializeBatch(ids: readonly string[]): string {
  return ids.slice(-MAX_BATCH_REMEMBERED).join(',');
}

export async function readBatch(tokenId: string): Promise<string[]> {
  const store = await cookies();
  return parseBatch(store.get(batchCookieName(tokenId))?.value);
}

export async function clearBatch(tokenId: string): Promise<void> {
  const store = await cookies();
  store.delete(batchCookieName(tokenId));
}

/** Same question, for a request that carries cookies but no Next page context. */
export function contributorFromCookieHeader(
  cookieHeader: string | null,
  context: ContributorContext,
): Participant | undefined {
  if (context.participant) return context.participant;
  const value = readCookieHeader(cookieHeader, contributorCookieName(context.token.id));
  return contributorForMemorial(db(), context.memorial.id, value);
}

export function readCookieHeader(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  const match = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return match?.slice(name.length + 1);
}
