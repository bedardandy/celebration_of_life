import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, insertOne, magicTokens, memorials, type Db, type Memorial } from '@col/db';
import {
  createDelegatedAsk,
  ensureCollectionLink,
  LINK_CLOSED_COPY,
  listCollectionLinks,
  joinAsContributor,
  resolveCollectionToken,
  revokeCollectionLink,
} from './links';
import { ASK_TEMPLATES, getAskTemplate, renderAsk } from './asks';
import { messageDrafts } from './messages';
import { recoverShareableToken, revokeToken } from '../auth/tokens';

let db: Db;
let memorial: Memorial;

beforeEach(() => {
  process.env['SESSION_SECRET'] = 'collection-link-test-secret';
  process.env['APP_BASE_URL'] = 'http://localhost:3000';
  db = createTestDb();
  memorial = insertOne(db, memorials, {
    decedentName: 'Ruth Margaret Kelleher',
    decedentKnownAs: 'Ruth',
    birthYear: 1938,
    deathYear: 2026,
  });
});

afterEach(() => {
  db.$sqlite.close();
  delete process.env['LINK_SECRET'];
});

describe('the family link', () => {
  it('is created once and handed back on every later visit', () => {
    const first = ensureCollectionLink(db, memorial.id);
    const second = ensureCollectionLink(db, memorial.id);
    expect(second.id).toBe(first.id);
    expect(first.kind).toBe('collection-link');
    expect(first.scopes).toEqual(['upload', 'memory-note']);
    // "This link keeps working" is a promise, so it cannot quietly expire.
    expect(first.expiresAt).toBeNull();
    expect(first.maxUses).toBeNull();
  });

  it('can be shown again later — the organiser printed the QR code', () => {
    const row = ensureCollectionLink(db, memorial.id);
    const token = recoverShareableToken(row) as string;
    expect(token).toBeTypeOf('string');

    const link = listCollectionLinks(db, memorial)[0];
    expect(link?.url).toBe(`http://localhost:3000/c/${token}`);

    // And it is the token that actually opens the page.
    const resolved = resolveCollectionToken(db, token);
    expect(resolved.ok).toBe(true);
  });

  it('stores only a hash — the plaintext is not in the row', () => {
    const row = ensureCollectionLink(db, memorial.id);
    const token = recoverShareableToken(row) as string;
    expect(row.tokenHash).not.toContain(token);
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it('cannot be recovered once the link secret changes, and says so', () => {
    const row = ensureCollectionLink(db, memorial.id);
    process.env['LINK_SECRET'] = 'a-different-secret-entirely';
    expect(recoverShareableToken(row)).toBeUndefined();
    expect(listCollectionLinks(db, memorial)[0]?.url).toBeUndefined();
  });

  it('stops working when revoked, without touching what already arrived', () => {
    const row = ensureCollectionLink(db, memorial.id);
    const token = recoverShareableToken(row) as string;
    expect(revokeCollectionLink(db, memorial.id, row.id)).toBe(true);

    const resolved = resolveCollectionToken(db, token);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error('expected a rejection');
    expect(resolved.reason).toBe('revoked');
    expect(LINK_CLOSED_COPY[resolved.reason].title).toBe('This link is no longer active');

    // A new one can be made, and it is genuinely a different link.
    const replacement = ensureCollectionLink(db, memorial.id);
    expect(replacement.id).not.toBe(row.id);
  });

  it('refuses to revoke a link belonging to another memorial', () => {
    const other = insertOne(db, memorials, { decedentName: 'Someone Else' });
    const row = ensureCollectionLink(db, memorial.id);
    expect(revokeCollectionLink(db, other.id, row.id)).toBe(false);
  });
});

describe('a personal ask', () => {
  it('carries the bounded ask through to the landing page', () => {
    const deadline = Date.UTC(2026, 7, 5, 12, 0);
    const { token, participant, url } = createDelegatedAsk(db, {
      memorialId: memorial.id,
      name: 'Aunt Mary',
      templateSlug: 'younger-years',
      deadlineAt: deadline,
    });

    expect(participant.role).toBe('contributor');
    expect(participant.displayName).toBe('Aunt Mary');
    expect(token.label).toBe('Aunt Mary');
    expect(token.askTemplate).toBe('younger-years');
    expect(url).toContain('/c/');

    const resolved = resolveCollectionToken(db, recoverShareableToken(token) as string);
    if (!resolved.ok) throw new Error('expected the ask to open');
    expect(resolved.context.ask.heading).toBe('Photos of Ruth when they were young');
    expect(resolved.context.ask.body).toContain('earlier in their life');
    expect(resolved.context.ask.deadlineLine).toContain('Wednesday');
    expect(resolved.context.participant?.id).toBe(participant.id);
  });

  it('keeps the words the organiser wrote, when they wrote some', () => {
    const { token } = createDelegatedAsk(db, {
      memorialId: memorial.id,
      name: 'Tom',
      templateSlug: 'era-or-theme',
      focus: 'the boat',
      note: 'Tom — any pictures of Dad and the boat? Even bad ones.',
    });
    expect(token.askNote).toBe('Tom — any pictures of Dad and the boat? Even bad ones.');
  });

  it('writes the focus into the ask when the organiser used the template', () => {
    const { token } = createDelegatedAsk(db, {
      memorialId: memorial.id,
      name: 'Tom',
      templateSlug: 'era-or-theme',
      focus: 'the boat',
    });
    expect(token.askNote).toContain('the boat');
  });

  it('is listed for the organiser with what has arrived through it', () => {
    createDelegatedAsk(db, { memorialId: memorial.id, name: 'Aunt Mary', templateSlug: 'anything' });
    ensureCollectionLink(db, memorial.id);

    const links = listCollectionLinks(db, memorial);
    expect(links).toHaveLength(2);
    expect(links.every((l) => l.active)).toBe(true);
    expect(links.map((l) => l.photoCount)).toEqual([0, 0]);
    expect(links.some((l) => l.label === 'Aunt Mary')).toBe(true);
  });
});

describe('arriving through a link', () => {
  it('is rejected gently when the link is nonsense', () => {
    const resolved = resolveCollectionToken(db, 'not-a-real-token');
    if (resolved.ok) throw new Error('expected a rejection');
    expect(resolved.reason).toBe('not-found');
    expect(LINK_CLOSED_COPY['not-found'].body).toMatch(/check with the family/i);
  });

  it('refuses an organiser login link, which is a different kind of thing', () => {
    const row = insertOne(db, magicTokens, {
      memorialId: memorial.id,
      tokenHash: 'x'.repeat(64),
      kind: 'organizer-login',
    });
    expect(row.kind).toBe('organizer-login');
    const resolved = resolveCollectionToken(db, 'y'.repeat(43));
    expect(resolved.ok).toBe(false);
  });

  it('will not open a memorial the family has removed', () => {
    const row = ensureCollectionLink(db, memorial.id);
    const token = recoverShareableToken(row) as string;
    db.update(memorials).set({ deletedAt: Date.now() }).run();
    const resolved = resolveCollectionToken(db, token);
    if (resolved.ok) throw new Error('expected a rejection');
    expect(resolved.reason).toBe('gone');
  });

  it('remembers a first name against the family link, and updates a personal ask', () => {
    const family = ensureCollectionLink(db, memorial.id);
    const resolvedFamily = resolveCollectionToken(db, recoverShareableToken(family) as string);
    if (!resolvedFamily.ok) throw new Error('expected the family link to open');

    const joined = joinAsContributor(db, resolvedFamily.context, '  Siobhán  ');
    expect(joined.displayName).toBe('Siobhán');
    expect(joined.role).toBe('contributor');

    const personal = createDelegatedAsk(db, {
      memorialId: memorial.id,
      name: 'Mary',
      templateSlug: 'anything',
    });
    const resolvedPersonal = resolveCollectionToken(
      db,
      recoverShareableToken(personal.token) as string,
    );
    if (!resolvedPersonal.ok) throw new Error('expected the personal ask to open');
    const same = joinAsContributor(db, resolvedPersonal.context, 'Mary Anne');
    expect(same.id).toBe(personal.participant.id);
    expect(same.displayName).toBe('Mary Anne');
  });

  it('does not consume a use — the cousin comes back next week', () => {
    const row = ensureCollectionLink(db, memorial.id);
    const token = recoverShareableToken(row) as string;
    for (let i = 0; i < 5; i += 1) expect(resolveCollectionToken(db, token).ok).toBe(true);
    revokeToken(db, row.id);
    expect(resolveCollectionToken(db, token).ok).toBe(false);
  });
});

describe('the words', () => {
  it('offers a template for every shape of ask an organiser has', () => {
    expect(ASK_TEMPLATES.map((t) => t.slug)).toEqual([
      'recent-photos',
      'younger-years',
      'era-or-theme',
      'one-story',
      'anything',
    ]);
    expect(getAskTemplate('nonsense').slug).toBe('anything');
  });

  it('renders an ask without a deadline as an ask, not a demand', () => {
    const ask = renderAsk({ templateSlug: 'recent-photos', decedentName: 'Ruth' });
    expect(ask.heading).toBe('Photos of Ruth from recent years');
    expect(ask.deadlineLine).toBeUndefined();
    expect(ask.body).not.toMatch(/must|need to|required/i);
  });

  it('writes both messages for the organiser, short one first', () => {
    const drafts = messageDrafts({
      decedentName: 'Ruth Margaret Kelleher',
      knownAs: 'Ruth',
      link: 'http://localhost:3000/c/abc',
      organizerName: 'Anne',
      deadlineAt: Date.UTC(2026, 7, 5, 12, 0),
    });

    const sms = drafts[0];
    expect(sms?.id).toBe('sms');
    expect(sms?.body).toContain('Ruth');
    expect(sms?.body).toContain('http://localhost:3000/c/abc');
    expect(sms?.body).toContain('by Wednesday');
    expect(sms?.body.length).toBeLessThan(320);

    const email = drafts[1];
    expect(email?.subject).toBe("Photos for Ruth's celebration of life");
    expect(email?.body).toContain('Anne');
    expect(email?.body).toContain('keeps working');
  });

  it('uses a first name when the family did not give a familiar one', () => {
    const drafts = messageDrafts({
      decedentName: 'Margaret Ellen Doyle',
      link: 'http://x/c/1',
    });
    expect(drafts[0]?.body).toContain('Margaret');
    expect(drafts[0]?.body).not.toContain('Ellen');
  });
});
