/**
 * Collection links, and the people who arrive through them.
 *
 * One family link that everybody gets, plus personal asks made of named people.
 * Both are capability URLs: no account, no password, no app. The whole design
 * rests on one promise made to a contributor — "this link keeps working" — so
 * nothing here expires on its own, and revoking is an explicit act by the
 * organiser with plain words attached.
 */
import {
  and,
  desc,
  eq,
  getById,
  insertOne,
  isNull,
  listWhere,
  magicTokens,
  mediaAssets,
  memorials,
  memoryNotes,
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
import { getAskTemplate, renderAsk, type AskTemplateSlug, type RenderedAsk } from './asks';

export const COLLECTION_SCOPES = ['upload', 'memory-note'] as const;

export type CollectionLink = {
  row: MagicToken;
  /** Undefined when the link secret has changed and the link cannot be shown again. */
  url?: string;
  token?: string;
  active: boolean;
  label?: string;
  ask: RenderedAsk;
  /** How many photos have arrived through this particular link. */
  photoCount: number;
  memoryCount: number;
};

/* -------------------------------------------------------------------------- */
/* issuing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The family link. There is exactly one live one per memorial: two links to the
 * same thing is a decision nobody wants to make while planning a funeral.
 */
export function ensureCollectionLink(db: Db, memorialId: string): MagicToken {
  const existing = listWhere(
    db,
    magicTokens,
    and(
      eq(magicTokens.memorialId, memorialId),
      eq(magicTokens.kind, 'collection-link'),
      isNull(magicTokens.revokedAt),
    ),
  )[0];
  if (existing) return existing;
  return issueShareableToken(db, { memorialId, kind: 'collection-link' }).row;
}

export type DelegatedAskInput = {
  memorialId: string;
  /** The person being asked, as the organiser types it: "Aunt Mary". */
  name: string;
  templateSlug: AskTemplateSlug;
  /** For the 'era-or-theme' template: "the boat", "her twenties". */
  focus?: string | null;
  /** The organiser's own words, if they would rather write them. */
  note?: string | null;
  deadlineAt?: number | null;
  now?: number;
};

/**
 * A personal ask. It creates the contributor participant up front so the
 * organiser can see who has been asked and who has answered, and so photos
 * carry an attribution even if the person never types their name.
 */
export function createDelegatedAsk(
  db: Db,
  input: DelegatedAskInput,
): { token: MagicToken; participant: Participant; url?: string } {
  const now = input.now ?? Date.now();
  const name = input.name.trim();
  const memorial = getById(db, memorials, input.memorialId);
  if (!memorial) throw new Error('createDelegatedAsk: no such memorial');

  const participant = insertOne(db, participants, {
    memorialId: input.memorialId,
    role: 'contributor',
    displayName: name || null,
    invitedAt: now,
  });

  const template = getAskTemplate(input.templateSlug);
  // The ask is written out in full at creation time rather than re-rendered on
  // every visit: the organiser may have typed their own words, and a template
  // whose wording we improve next month should not silently change an ask
  // somebody has already read.
  const askNote =
    (input.note ?? '').trim() ||
    renderAsk({
      templateSlug: template.slug,
      decedentName: memorial.decedentKnownAs || memorial.decedentName,
      focus: input.focus,
    }).body;

  const issued = issueShareableToken(db, {
    memorialId: input.memorialId,
    kind: 'contributor',
    participantId: participant.id,
    label: name || null,
    askTemplate: template.slug,
    askNote,
    deadlineAt: input.deadlineAt ?? null,
    now,
  });

  return { token: issued.row, participant, url: issued.url };
}

/* -------------------------------------------------------------------------- */
/* listing                                                                     */
/* -------------------------------------------------------------------------- */

function countFor(db: Db, memorialId: string, participantId: string | null): number {
  if (!participantId) return 0;
  return listWhere(
    db,
    mediaAssets,
    and(
      eq(mediaAssets.memorialId, memorialId),
      eq(mediaAssets.uploadedByParticipantId, participantId),
      isNull(mediaAssets.deletedAt),
    ),
  ).length;
}

function memoryCountFor(db: Db, memorialId: string, participantId: string | null): number {
  if (!participantId) return 0;
  return listWhere(
    db,
    memoryNotes,
    and(
      eq(memoryNotes.memorialId, memorialId),
      eq(memoryNotes.participantId, participantId),
      isNull(memoryNotes.deletedAt),
    ),
  ).length;
}

export function describeLink(db: Db, memorial: Memorial, row: MagicToken): CollectionLink {
  const token = recoverShareableToken(row);
  const ask = renderAsk({
    templateSlug: row.askTemplate,
    decedentName: memorial.decedentKnownAs || memorial.decedentName,
    note: row.askNote,
    deadlineAt: row.deadlineAt,
    timezone: memorial.timezone,
  });
  return {
    row,
    ...(token ? { token, url: tokenUrl(row.kind, token) } : {}),
    active: row.revokedAt == null,
    ...(row.label ? { label: row.label } : {}),
    ask,
    photoCount: countFor(db, memorial.id, row.participantId),
    memoryCount: memoryCountFor(db, memorial.id, row.participantId),
  };
}

export function listCollectionLinks(db: Db, memorial: Memorial): CollectionLink[] {
  const rows = db
    .select()
    .from(magicTokens)
    .where(eq(magicTokens.memorialId, memorial.id))
    .orderBy(desc(magicTokens.createdAt))
    .all()
    .filter((r) => r.kind === 'collection-link' || r.kind === 'contributor');
  return rows.map((row) => describeLink(db, memorial, row));
}

export function revokeCollectionLink(db: Db, memorialId: string, tokenId: string): boolean {
  const row = getById(db, magicTokens, tokenId);
  if (!row || row.memorialId !== memorialId) return false;
  if (row.kind !== 'collection-link' && row.kind !== 'contributor') return false;
  return revokeToken(db, tokenId) !== undefined;
}

/* -------------------------------------------------------------------------- */
/* arriving                                                                    */
/* -------------------------------------------------------------------------- */

export type ContributorContext = {
  token: MagicToken;
  memorial: Memorial;
  ask: RenderedAsk;
  /** The participant the token was issued for, when it was a personal ask. */
  participant?: Participant;
  canUpload: boolean;
  canWriteMemory: boolean;
};

export type ContributorResolution =
  { ok: true; context: ContributorContext } | { ok: false; reason: TokenRejection | 'gone' };

/**
 * Turn a link into a page. Never consumes a use: a contributor link is meant to
 * be opened again next week, when another photo turns up in a drawer.
 */
export function resolveCollectionToken(
  db: Db,
  token: string,
  options: { now?: number } = {},
): ContributorResolution {
  const found = inspectToken(db, token, options);
  if (!found.ok) return { ok: false, reason: found.reason };
  const row = found.row;
  if (row.kind !== 'collection-link' && row.kind !== 'contributor') {
    return { ok: false, reason: 'wrong-kind' };
  }

  const memorial = getById(db, memorials, row.memorialId);
  if (!memorial || memorial.deletedAt != null) return { ok: false, reason: 'gone' };

  const participant = row.participantId ? getById(db, participants, row.participantId) : undefined;
  return {
    ok: true,
    context: {
      token: row,
      memorial,
      ask: renderAsk({
        templateSlug: row.askTemplate,
        decedentName: memorial.decedentKnownAs || memorial.decedentName,
        note: row.askNote,
        deadlineAt: row.deadlineAt,
        timezone: memorial.timezone,
      }),
      ...(participant ? { participant } : {}),
      canUpload: row.scopes.includes('upload'),
      canWriteMemory: row.scopes.includes('memory-note'),
    },
  };
}

/**
 * "What should we call you?" — the only question a contributor is asked before
 * they can help, and it is optional in spirit: an empty name still uploads.
 */
export function joinAsContributor(
  db: Db,
  context: ContributorContext,
  displayName: string,
  now: number = Date.now(),
): Participant {
  const name = displayName.trim().slice(0, 80);

  if (context.participant) {
    return (
      updateById(db, participants, context.participant.id, {
        ...(name ? { displayName: name } : {}),
        lastSeenAt: now,
      }) ?? context.participant
    );
  }

  return insertOne(db, participants, {
    memorialId: context.memorial.id,
    role: 'contributor',
    displayName: name || null,
    invitedAt: now,
    lastSeenAt: now,
  });
}

/** The participant behind an id, only if they belong to this memorial. */
export function contributorForMemorial(
  db: Db,
  memorialId: string,
  participantId: string | undefined | null,
): Participant | undefined {
  if (!participantId) return undefined;
  const participant = getById(db, participants, participantId);
  if (!participant) return undefined;
  if (participant.memorialId !== memorialId) return undefined;
  if (participant.revokedAt != null) return undefined;
  return participant;
}

/** Plain, non-blaming wording for a link that no longer opens anything. */
export const LINK_CLOSED_COPY: Record<TokenRejection | 'gone', { title: string; body: string }> = {
  'not-found': {
    title: 'We could not find that link',
    body: 'It may have been copied without the last few characters. Please check with the family — they can send it again.',
  },
  revoked: {
    title: 'This link is no longer active',
    body: 'Please check with the family. Anything you already shared is safe with them.',
  },
  expired: {
    title: 'This link is no longer active',
    body: 'Please check with the family — they can send you a new one.',
  },
  'already-used': {
    title: 'This link is no longer active',
    body: 'Please check with the family — they can send you a new one.',
  },
  'wrong-kind': {
    title: 'This link opens something else',
    body: 'Please check with the family — they can send you the right one.',
  },
  gone: {
    title: 'This link is no longer active',
    body: 'Please check with the family. Anything you already shared is safe with them.',
  },
};
