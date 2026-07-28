/**
 * The gate in front of every organizer page.
 *
 * One call, at the top of the page or action. If the session does not fit the
 * memorial in the URL, the person is sent to the front page rather than shown
 * an error — a locked door with an explanation is no use to someone who just
 * needs their link again.
 */
import { redirect } from 'next/navigation';
import {
  authorizeOrganizer,
  touchParticipant,
  type AuthorizeOptions,
  type OrganizerContext,
} from '@col/core';
import { db } from './db';
import { readSession } from './session';

export async function requireOrganizer(
  memorialId: string,
  options: AuthorizeOptions = {},
): Promise<OrganizerContext> {
  const session = await readSession();
  const result = authorizeOrganizer(db(), session, memorialId, options);
  if (!result.ok) {
    redirect(result.reason === 'no-session' ? '/resume?reason=signed-out' : '/');
  }
  touchParticipant(db(), result.context.participant.id);
  return result.context;
}

/** Non-redirecting form, for places that need to decide for themselves. */
export async function currentOrganizer(memorialId: string): Promise<OrganizerContext | undefined> {
  const session = await readSession();
  const result = authorizeOrganizer(db(), session, memorialId);
  return result.ok ? result.context : undefined;
}
