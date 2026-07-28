import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, insertOne, magicTokens, memorials, participants, type Db } from '@col/db';
import {
  ORGANIZER_LOGIN_TTL_MS,
  TOKEN_REJECTION_MESSAGE,
  generateTokenValue,
  hashToken,
  inspectToken,
  issueToken,
  redeemToken,
  resolveContributorToken,
  revokeToken,
  tokenUrl,
} from './tokens';

const NOW = 1_800_000_000_000;

let db: Db;
let memorialId: string;
let participantId: string;

beforeEach(() => {
  process.env['APP_BASE_URL'] = 'https://example.test';
  db = createTestDb();
  memorialId = insertOne(db, memorials, { decedentName: 'Ruth' }).id;
  participantId = insertOne(db, participants, { memorialId, role: 'organizer' }).id;
});

describe('token material', () => {
  it('is 32 random bytes, base64url, and different every time', () => {
    const a = generateTokenValue();
    const b = generateTokenValue();
    expect(a).not.toBe(b);
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('never stores the plaintext — only its SHA-256', () => {
    const issued = issueToken(db, { memorialId, participantId, kind: 'organizer-login' });
    const stored = db.select().from(magicTokens).all();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.tokenHash).toBe(hashToken(issued.token));
    expect(stored[0]?.tokenHash).not.toContain(issued.token);
    expect(JSON.stringify(stored)).not.toContain(issued.token);
  });

  it('composes an absolute link from APP_BASE_URL', () => {
    const issued = issueToken(db, { memorialId, participantId, kind: 'organizer-login' });
    expect(issued.url).toBe(`https://example.test/auth/${issued.token}`);
    expect(tokenUrl('contributor', 'abc')).toBe('https://example.test/c/abc');
  });
});

describe('redeeming an organizer login token', () => {
  it('works once', () => {
    const issued = issueToken(db, {
      memorialId,
      participantId,
      kind: 'organizer-login',
      ttlMs: ORGANIZER_LOGIN_TTL_MS,
      now: NOW,
    });
    const first = redeemToken(db, issued.token, { now: NOW + 1000 });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.row.usedCount).toBe(1);
      expect(first.row.lastUsedAt).toBe(NOW + 1000);
      expect(first.row.participantId).toBe(participantId);
    }
  });

  it('refuses the second use', () => {
    const issued = issueToken(db, { memorialId, participantId, kind: 'organizer-login', now: NOW });
    expect(redeemToken(db, issued.token, { now: NOW }).ok).toBe(true);
    const second = redeemToken(db, issued.token, { now: NOW });
    expect(second).toMatchObject({ ok: false, reason: 'already-used' });
  });

  it('refuses a token past its expiry', () => {
    const issued = issueToken(db, {
      memorialId,
      participantId,
      kind: 'organizer-login',
      ttlMs: ORGANIZER_LOGIN_TTL_MS,
      now: NOW,
    });
    const after = NOW + ORGANIZER_LOGIN_TTL_MS + 1;
    expect(redeemToken(db, issued.token, { now: after })).toMatchObject({
      ok: false,
      reason: 'expired',
    });
  });

  it('refuses a revoked token', () => {
    const issued = issueToken(db, { memorialId, participantId, kind: 'organizer-login', now: NOW });
    revokeToken(db, issued.row.id, NOW);
    expect(redeemToken(db, issued.token, { now: NOW })).toMatchObject({
      ok: false,
      reason: 'revoked',
    });
  });

  it('refuses a tampered token, and does not consume the real one', () => {
    const issued = issueToken(db, { memorialId, participantId, kind: 'organizer-login', now: NOW });
    const tampered = `${issued.token.slice(0, -1)}${issued.token.endsWith('A') ? 'B' : 'A'}`;
    expect(redeemToken(db, tampered, { now: NOW })).toMatchObject({
      ok: false,
      reason: 'not-found',
    });
    expect(redeemToken(db, issued.token, { now: NOW }).ok).toBe(true);
  });

  it('refuses empty and truncated input without touching the database', () => {
    for (const bad of ['', 'short', 'x'.repeat(15)]) {
      expect(redeemToken(db, bad, { now: NOW })).toMatchObject({ ok: false, reason: 'not-found' });
    }
  });

  it('refuses a contributor token presented as a login', () => {
    const issued = issueToken(db, { memorialId, kind: 'contributor', now: NOW });
    expect(redeemToken(db, issued.token, { now: NOW, kind: 'organizer-login' })).toMatchObject({
      ok: false,
      reason: 'wrong-kind',
    });
  });
});

describe('contributor tokens', () => {
  it('keep working — inspection does not consume them', () => {
    const issued = issueToken(db, { memorialId, kind: 'contributor', now: NOW });
    for (let i = 0; i < 5; i += 1) {
      expect(resolveContributorToken(db, issued.token, { now: NOW }).ok).toBe(true);
    }
    expect(inspectToken(db, issued.token, { now: NOW })).toMatchObject({ ok: true });
    const stored = db.select().from(magicTokens).all()[0];
    expect(stored?.usedCount).toBe(0);
  });

  it('refuse an organizer login token', () => {
    const issued = issueToken(db, { memorialId, participantId, kind: 'organizer-login', now: NOW });
    expect(resolveContributorToken(db, issued.token, { now: NOW })).toMatchObject({
      ok: false,
      reason: 'wrong-kind',
    });
  });
});

describe('rejection copy', () => {
  it('never blames the person holding the link', () => {
    for (const message of Object.values(TOKEN_REJECTION_MESSAGE)) {
      expect(message).not.toMatch(/invalid|error|denied|forbidden/i);
      expect(message.length).toBeLessThan(120);
    }
  });
});
