/**
 * Creating a memorial, and getting back into one.
 *
 * This is the whole of "signing up": a name, your name, your email. Three
 * fields, because the person filling them in may have been awake since four in
 * the morning. Everything else is asked later, one question at a time, and all
 * of it can be skipped.
 */
import {
  and,
  desc,
  eq,
  insertOne,
  isNull,
  memorials,
  participants,
  people,
  type Db,
  type Memorial,
  type Participant,
  type Person,
} from '@col/db';
import { DEFAULT_TRADITION_SLUG, getPack } from '@col/tradition-packs';
import { issueToken, ORGANIZER_LOGIN_TTL_MS, type IssuedToken } from '../auth/tokens';

export type CreateMemorialInput = {
  /** The person who died. */
  decedentName: string;
  organizerName: string;
  organizerEmail: string;
  now?: number;
};

export type CreatedMemorial = {
  memorial: Memorial;
  decedent: Person;
  organizer: Participant;
  login: IssuedToken;
};

export class InvalidMemorialInput extends Error {
  constructor(
    readonly field: 'decedentName' | 'organizerName' | 'organizerEmail',
    message: string,
  ) {
    super(message);
    this.name = 'InvalidMemorialInput';
  }
}

/** Deliberately forgiving: we check for something plausible, not for RFC 5322. */
export function looksLikeEmail(value: string): boolean {
  const trimmed = value.trim();
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(trimmed) && trimmed.length <= 254;
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function validateCreateInput(input: {
  decedentName: string;
  organizerName: string;
  organizerEmail: string;
}): InvalidMemorialInput | undefined {
  if (input.decedentName.trim().length === 0) {
    return new InvalidMemorialInput('decedentName', 'Please add their name so we can start.');
  }
  if (input.organizerName.trim().length === 0) {
    return new InvalidMemorialInput('organizerName', 'Please add your name.');
  }
  if (!looksLikeEmail(input.organizerEmail)) {
    return new InvalidMemorialInput(
      'organizerEmail',
      'Please check the email address — we send your link there.',
    );
  }
  return undefined;
}

export function createMemorial(db: Db, input: CreateMemorialInput): CreatedMemorial {
  const invalid = validateCreateInput(input);
  if (invalid) throw invalid;

  const now = input.now ?? Date.now();
  const decedentName = input.decedentName.trim();
  const pack = getPack(DEFAULT_TRADITION_SLUG);

  const memorial = insertOne(db, memorials, {
    decedentName,
    traditionSlug: DEFAULT_TRADITION_SLUG,
    pacingPreset: pack.pacingPreset,
    status: 'draft',
    checklist: {},
  });

  const decedent = insertOne(db, people, {
    memorialId: memorial.id,
    fullName: decedentName,
    isDecedent: true,
  });

  const organizer = insertOne(db, participants, {
    memorialId: memorial.id,
    role: 'organizer',
    displayName: input.organizerName.trim(),
    email: normalizeEmail(input.organizerEmail),
    invitedAt: now,
    lastSeenAt: now,
  });

  const login = issueToken(db, {
    memorialId: memorial.id,
    participantId: organizer.id,
    kind: 'organizer-login',
    ttlMs: ORGANIZER_LOGIN_TTL_MS,
    now,
  });

  return { memorial, decedent, organizer, login };
}

/**
 * The organiser for an email address. If someone has helped with more than one
 * memorial we take the most recent, which is almost always the one they mean.
 */
export function findOrganizerByEmail(db: Db, email: string): Participant | undefined {
  const rows = db
    .select()
    .from(participants)
    .where(
      and(
        eq(participants.email, normalizeEmail(email)),
        eq(participants.role, 'organizer'),
        isNull(participants.revokedAt),
      ),
    )
    .orderBy(desc(participants.createdAt))
    .limit(1)
    .all();
  return rows[0];
}

export function issueOrganizerLoginLink(
  db: Db,
  organizer: Participant,
  now: number = Date.now(),
): IssuedToken {
  return issueToken(db, {
    memorialId: organizer.memorialId,
    participantId: organizer.id,
    kind: 'organizer-login',
    ttlMs: ORGANIZER_LOGIN_TTL_MS,
    now,
  });
}

export type LoginLinkRequest = {
  /** True whenever the address was well-formed, whether or not we knew it. */
  accepted: boolean;
  /** Present only when an organiser actually exists. Never shown to the browser. */
  issued?: IssuedToken;
  organizer?: Participant;
  memorial?: Memorial;
};

/**
 * "I already have one." The answer to the person is always the same sentence,
 * whether or not we recognised the address — nobody gets to probe this app for
 * who is grieving.
 */
export function requestLoginLink(
  db: Db,
  email: string,
  now: number = Date.now(),
): LoginLinkRequest {
  if (!looksLikeEmail(email)) return { accepted: false };
  const organizer = findOrganizerByEmail(db, email);
  if (!organizer) return { accepted: true };
  const rows = db.select().from(memorials).where(eq(memorials.id, organizer.memorialId)).all();
  const memorial = rows[0];
  if (!memorial || memorial.deletedAt != null) return { accepted: true };
  return {
    accepted: true,
    issued: issueOrganizerLoginLink(db, organizer, now),
    organizer,
    memorial,
  };
}
