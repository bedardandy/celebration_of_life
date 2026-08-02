/**
 * Sharing the work.
 *
 * Almost nobody should be doing this alone, and in most families somebody else
 * is already asking "what can I do?". This is the honest answer: a link that
 * hands them the same job — the same screens, the same buttons, the same
 * memorial — with no account to make and nothing to install.
 *
 * It is a capability URL, like the collection link and the viewing link, and it
 * is deliberately blunt about what that means: possession of the link *is* the
 * permission, so the screen that shows it says "share it carefully" and the
 * screen that opens it says so again. Turning it off stops the link opening;
 * it does not sign out somebody who already came through, because pretending
 * otherwise would be a lie told about somebody's access.
 */
import {
  and,
  desc,
  eq,
  getById,
  insertOne,
  listWhere,
  magicTokens,
  memorials,
  participants,
  updateById,
  type Db,
  type MagicToken,
  type Memorial,
  type Participant,
} from '@col/db';
import {
  inspectToken,
  issueShareableToken,
  recoverShareableToken,
  revokeToken,
  tokenUrl,
  type TokenRejection,
} from '../auth/tokens';
import { normalizeEmail } from '../memorial/create';

/** What the link is for. Never confused with a contributor's upload scope. */
export const CO_ORGANIZER_INVITE_SCOPE = 'co-organizer-invite';

export type CoOrganizerInvite = {
  row: MagicToken;
  /** Undefined when the link secret changed and it cannot be shown again. */
  url?: string;
  token?: string;
  active: boolean;
};

export function describeCoOrganizerInvite(row: MagicToken): CoOrganizerInvite {
  const token = recoverShareableToken(row);
  return {
    row,
    ...(token ? { token, url: tokenUrl('co-organizer-invite', token) } : {}),
    active: row.revokedAt == null,
  };
}

export function createCoOrganizerInvite(db: Db, memorialId: string): CoOrganizerInvite {
  const issued = issueShareableToken(db, {
    memorialId,
    kind: 'co-organizer-invite',
    scopes: [CO_ORGANIZER_INVITE_SCOPE],
  });
  return describeCoOrganizerInvite(issued.row);
}

export function listCoOrganizerInvites(db: Db, memorialId: string): CoOrganizerInvite[] {
  return db
    .select()
    .from(magicTokens)
    .where(eq(magicTokens.memorialId, memorialId))
    .orderBy(desc(magicTokens.createdAt))
    .all()
    .filter((row) => row.kind === 'co-organizer-invite')
    .map(describeCoOrganizerInvite);
}

export function revokeCoOrganizerInvite(db: Db, memorialId: string, tokenId: string): boolean {
  const row = getById(db, magicTokens, tokenId);
  if (!row || row.memorialId !== memorialId || row.kind !== 'co-organizer-invite') return false;
  return revokeToken(db, tokenId) !== undefined;
}

/* -------------------------------------------------------------------------- */
/* arriving                                                                    */
/* -------------------------------------------------------------------------- */

export type InviteContext = { token: MagicToken; memorial: Memorial };

export type InviteResolution =
  { ok: true; context: InviteContext } | { ok: false; reason: TokenRejection | 'gone' };

/** Turn an invite link into a page. Never consumes a use. */
export function resolveInviteToken(
  db: Db,
  token: string,
  options: { now?: number } = {},
): InviteResolution {
  const found = inspectToken(db, token, options);
  if (!found.ok) return { ok: false, reason: found.reason };
  if (found.row.kind !== 'co-organizer-invite') return { ok: false, reason: 'wrong-kind' };

  const memorial = getById(db, memorials, found.row.memorialId);
  if (!memorial || memorial.deletedAt != null) return { ok: false, reason: 'gone' };
  return { ok: true, context: { token: found.row, memorial } };
}

export type AcceptInviteInput = {
  token: string;
  firstName: string;
  email: string;
  now?: number;
};

export type AcceptedInvite = { participant: Participant; memorial: Memorial };

export type AcceptInviteResult =
  ({ ok: true } & AcceptedInvite) | { ok: false; reason: TokenRejection | 'gone' };

/**
 * Somebody takes the offer up.
 *
 * The same email arriving twice is the same person — a co-organiser who opens
 * the link again on their phone should land in the memorial they already help
 * with, not become a second row. A contributor who is later handed the invite
 * is promoted in place, so the photographs they already sent keep their name on
 * them.
 */
export function acceptCoOrganizerInvite(db: Db, input: AcceptInviteInput): AcceptInviteResult {
  const now = input.now ?? Date.now();
  const resolved = resolveInviteToken(db, input.token, { now });
  if (!resolved.ok) return { ok: false, reason: resolved.reason };

  const { memorial } = resolved.context;
  const name = input.firstName.trim().slice(0, 80);
  const email = input.email.trim() ? normalizeEmail(input.email) : null;

  const existing = email
    ? listWhere(
        db,
        participants,
        and(eq(participants.memorialId, memorial.id), eq(participants.email, email)),
      )[0]
    : undefined;

  const participant = existing
    ? (updateById(db, participants, existing.id, {
        role: 'organizer',
        ...(name ? { displayName: name } : {}),
        revokedAt: null,
        lastSeenAt: now,
      }) ?? existing)
    : insertOne(db, participants, {
        memorialId: memorial.id,
        role: 'organizer',
        displayName: name || null,
        email,
        invitedAt: now,
        lastSeenAt: now,
      });

  // Counted rather than consumed: the link is meant to keep working, and the
  // count is what lets the organiser see that somebody took it up.
  updateById(db, magicTokens, resolved.context.token.id, {
    usedCount: resolved.context.token.usedCount + 1,
    lastUsedAt: now,
  });

  return { ok: true, participant, memorial };
}

/* -------------------------------------------------------------------------- */
/* words                                                                       */
/* -------------------------------------------------------------------------- */

export const CO_ORGANIZER_INVITE_OFFER =
  'Share the work with someone. They will see everything you see and can do everything you can.';

export const CO_ORGANIZER_INVITE_HELP =
  'Anyone with this link can manage the memorial — share it carefully. Turning it off stops the link opening; anyone who has already used it stays.';

export const CO_ORGANIZER_JOIN_HELP =
  'Anyone with this link can manage the memorial, so it is only for people the family trust with it.';
