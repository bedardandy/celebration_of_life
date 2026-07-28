import { beforeEach, describe, expect, it } from 'vitest';
import {
  and,
  createTestDb,
  eq,
  listWhere,
  magicTokens,
  memorials,
  participants,
  people,
  softDeleteById,
  type Db,
} from '@col/db';
import { redeemToken } from '../auth/tokens';
import { authorizeOrganizer } from '../auth/access';
import { encodeSession, decodeSession } from '../auth/session';
import {
  InvalidMemorialInput,
  createMemorial,
  findOrganizerByEmail,
  looksLikeEmail,
  requestLoginLink,
} from './create';

const NOW = Date.UTC(2026, 6, 28, 9, 0, 0);
const SECRET = 'test-secret';

let db: Db;

beforeEach(() => {
  process.env['APP_BASE_URL'] = 'https://example.test';
  db = createTestDb();
});

function create(overrides: Partial<Parameters<typeof createMemorial>[1]> = {}) {
  return createMemorial(db, {
    decedentName: 'Ruth Kelleher',
    organizerName: 'Anne Kelleher',
    organizerEmail: 'Anne@Example.test',
    now: NOW,
    ...overrides,
  });
}

describe('createMemorial', () => {
  it('creates the memorial, the person who died, the organizer and one login link', () => {
    const created = create();
    expect(created.memorial.decedentName).toBe('Ruth Kelleher');
    expect(created.memorial.status).toBe('draft');
    expect(created.decedent.isDecedent).toBe(true);
    expect(created.decedent.memorialId).toBe(created.memorial.id);
    expect(created.organizer.role).toBe('organizer');
    expect(created.organizer.displayName).toBe('Anne Kelleher');
    expect(created.login.url).toBe(`https://example.test/auth/${created.login.token}`);

    expect(listWhere(db, memorials)).toHaveLength(1);
    expect(listWhere(db, people)).toHaveLength(1);
    expect(listWhere(db, participants)).toHaveLength(1);
    expect(listWhere(db, magicTokens)).toHaveLength(1);
  });

  it('lowercases the email so "Anne@" and "anne@" are the same person', () => {
    const created = create();
    expect(created.organizer.email).toBe('anne@example.test');
    expect(findOrganizerByEmail(db, 'ANNE@EXAMPLE.TEST')?.id).toBe(created.organizer.id);
  });

  it('starts on the neutral tradition, so nobody is labelled before being asked', () => {
    expect(create().memorial.traditionSlug).toBe('secular');
    expect(create().memorial.pacingPreset).toBe('flexible');
  });

  it('asks for the three things it needs, in plain words', () => {
    expect(() => create({ decedentName: '  ' })).toThrow(InvalidMemorialInput);
    expect(() => create({ organizerName: '' })).toThrow(/your name/i);
    expect(() => create({ organizerEmail: 'not-an-email' })).toThrow(/email/i);
    expect(looksLikeEmail('anne@example.test')).toBe(true);
    expect(looksLikeEmail('anne@localhost')).toBe(false);
  });
});

describe('the walkthrough: create, redeem, be signed in', () => {
  it('turns a fresh login link into an organizer session for that memorial only', () => {
    const created = create();

    const redeemed = redeemToken(db, created.login.token, { now: NOW, kind: 'organizer-login' });
    expect(redeemed.ok).toBe(true);
    if (!redeemed.ok) return;

    const cookie = encodeSession(
      {
        participantId: redeemed.row.participantId as string,
        memorialId: redeemed.row.memorialId,
        role: 'organizer',
        issuedAt: NOW,
      },
      SECRET,
    );
    const session = decodeSession(cookie, { secret: SECRET, now: NOW });
    expect(session).toBeDefined();

    const allowed = authorizeOrganizer(db, session, created.memorial.id);
    expect(allowed.ok).toBe(true);
    if (allowed.ok) expect(allowed.context.memorial.decedentName).toBe('Ruth Kelleher');

    // The same session on somebody else's memorial is refused.
    const other = create({ decedentName: 'Someone Else', organizerEmail: 'other@example.test' });
    expect(authorizeOrganizer(db, session, other.memorial.id)).toMatchObject({
      ok: false,
      reason: 'wrong-memorial',
    });
  });

  it('refuses a session with no cookie, and one for a revoked organizer', () => {
    const created = create();
    expect(authorizeOrganizer(db, undefined, created.memorial.id)).toMatchObject({
      ok: false,
      reason: 'no-session',
    });

    const session = {
      participantId: created.organizer.id,
      memorialId: created.memorial.id,
      role: 'organizer' as const,
      issuedAt: NOW,
    };
    expect(authorizeOrganizer(db, session, created.memorial.id).ok).toBe(true);

    db.update(participants)
      .set({ revokedAt: NOW })
      .where(eq(participants.id, created.organizer.id))
      .run();
    expect(authorizeOrganizer(db, session, created.memorial.id)).toMatchObject({
      ok: false,
      reason: 'revoked',
    });
  });

  it('refuses a session for a memorial that has been removed', () => {
    const created = create();
    const session = {
      participantId: created.organizer.id,
      memorialId: created.memorial.id,
      role: 'organizer' as const,
      issuedAt: NOW,
    };
    softDeleteById(db, memorials, created.memorial.id, NOW);
    expect(authorizeOrganizer(db, session, created.memorial.id)).toMatchObject({
      ok: false,
      reason: 'gone',
    });
  });
});

describe('"I already have one"', () => {
  it('issues a fresh link for a known organizer', () => {
    const created = create();
    const result = requestLoginLink(db, 'anne@example.test', NOW + 1000);
    expect(result.accepted).toBe(true);
    expect(result.issued).toBeDefined();
    expect(result.memorial?.id).toBe(created.memorial.id);

    // The new link works even though the original one is untouched.
    const redeemed = redeemToken(db, result.issued?.token as string, { now: NOW + 1000 });
    expect(redeemed.ok).toBe(true);
  });

  it('answers the same way for an address we have never seen', () => {
    const unknown = requestLoginLink(db, 'nobody@example.test', NOW);
    expect(unknown.accepted).toBe(true);
    expect(unknown.issued).toBeUndefined();
    expect(listWhere(db, magicTokens, and(eq(magicTokens.kind, 'organizer-login')))).toHaveLength(
      0,
    );
  });

  it('declines to act on something that is not an email address', () => {
    expect(requestLoginLink(db, 'anne', NOW).accepted).toBe(false);
  });

  it('does not resurrect a removed memorial', () => {
    const created = create();
    softDeleteById(db, memorials, created.memorial.id, NOW);
    const result = requestLoginLink(db, 'anne@example.test', NOW);
    expect(result.accepted).toBe(true);
    expect(result.issued).toBeUndefined();
  });
});
