/**
 * Who is allowed to see what.
 *
 * One rule, applied in one place: a session may only touch the memorial it was
 * issued for. Everything else in the product reads this, so there is no second
 * opinion about access anywhere in the codebase.
 */
import {
  getById,
  memorials,
  participants,
  updateById,
  type Db,
  type Memorial,
  type Participant,
} from '@col/db';
import type { Session } from './session';

export type AccessDenial = 'no-session' | 'wrong-memorial' | 'not-organizer' | 'revoked' | 'gone';

export class AccessDeniedError extends Error {
  constructor(readonly reason: AccessDenial) {
    super(`Access denied: ${reason}`);
    this.name = 'AccessDeniedError';
  }
}

export type OrganizerContext = {
  session: Session;
  participant: Participant;
  memorial: Memorial;
};

export type AuthorizeResult =
  { ok: true; context: OrganizerContext } | { ok: false; reason: AccessDenial };

export type AuthorizeOptions = {
  /**
   * Let a tombstoned memorial through. Exactly one caller needs this: the Undo
   * that puts a just-removed memorial back. Without it, removing something
   * would revoke the access needed to un-remove it.
   */
  allowRemoved?: boolean;
};

export function authorizeOrganizer(
  db: Db,
  session: Session | undefined,
  memorialId: string,
  options: AuthorizeOptions = {},
): AuthorizeResult {
  if (!session) return { ok: false, reason: 'no-session' };
  if (session.memorialId !== memorialId) return { ok: false, reason: 'wrong-memorial' };
  if (session.role !== 'organizer') return { ok: false, reason: 'not-organizer' };

  const participant = getById(db, participants, session.participantId);
  if (!participant || participant.memorialId !== memorialId) {
    return { ok: false, reason: 'wrong-memorial' };
  }
  if (participant.revokedAt != null) return { ok: false, reason: 'revoked' };
  if (participant.role !== 'organizer') return { ok: false, reason: 'not-organizer' };

  const memorial = getById(db, memorials, memorialId);
  if (!memorial) return { ok: false, reason: 'gone' };
  if (memorial.deletedAt != null && !options.allowRemoved) return { ok: false, reason: 'gone' };

  return { ok: true, context: { session, participant, memorial } };
}

/** Throwing form, for call sites where a denial is genuinely exceptional. */
export function requireOrganizer(
  db: Db,
  session: Session | undefined,
  memorialId: string,
  options: AuthorizeOptions = {},
): OrganizerContext {
  const result = authorizeOrganizer(db, session, memorialId, options);
  if (!result.ok) throw new AccessDeniedError(result.reason);
  return result.context;
}

export function touchParticipant(db: Db, participantId: string, at: number = Date.now()): void {
  updateById(db, participants, participantId, { lastSeenAt: at });
}
