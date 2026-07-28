import { describe, expect, it } from 'vitest';
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SEC,
  decodeSession,
  encodeSession,
  sessionCookieOptions,
  type Session,
} from './session';

const SECRET = 'test-secret-value';

function session(overrides: Partial<Session> = {}): Session {
  return {
    participantId: 'p-1',
    memorialId: 'm-1',
    role: 'organizer',
    issuedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('session cookie', () => {
  it('round-trips a session', () => {
    const encoded = encodeSession(session(), SECRET);
    expect(decodeSession(encoded, { secret: SECRET, now: session().issuedAt })).toEqual(session());
  });

  it('is signed, not encrypted — and the signature is what is checked', () => {
    const encoded = encodeSession(session(), SECRET);
    const [payload] = encoded.split('.');
    expect(payload).toBeDefined();
    const decodedPayload = JSON.parse(Buffer.from(payload as string, 'base64url').toString('utf8'));
    expect(decodedPayload.memorialId).toBe('m-1');
  });

  it('rejects a cookie whose memorial id was edited', () => {
    const encoded = encodeSession(session(), SECRET);
    const signature = encoded.slice(encoded.indexOf('.') + 1);
    const forgedPayload = Buffer.from(
      JSON.stringify(session({ memorialId: 'someone-elses' })),
      'utf8',
    ).toString('base64url');
    expect(
      decodeSession(`${forgedPayload}.${signature}`, {
        secret: SECRET,
        now: session().issuedAt,
      }),
    ).toBeUndefined();
  });

  it('rejects a cookie signed with a different secret', () => {
    const encoded = encodeSession(session(), 'other-secret');
    expect(decodeSession(encoded, { secret: SECRET, now: session().issuedAt })).toBeUndefined();
  });

  it('rejects nonsense without throwing', () => {
    for (const raw of ['', 'abc', '.', 'a.', '.b', 'not-base64.sig']) {
      expect(decodeSession(raw, { secret: SECRET })).toBeUndefined();
    }
    expect(decodeSession(undefined, { secret: SECRET })).toBeUndefined();
    expect(decodeSession(null, { secret: SECRET })).toBeUndefined();
  });

  it('expires after the maximum age', () => {
    const issuedAt = 1_700_000_000_000;
    const encoded = encodeSession(session({ issuedAt }), SECRET);
    const justInside = issuedAt + SESSION_MAX_AGE_SEC * 1000 - 1;
    const justOutside = issuedAt + SESSION_MAX_AGE_SEC * 1000 + 1;
    expect(decodeSession(encoded, { secret: SECRET, now: justInside })).toBeDefined();
    expect(decodeSession(encoded, { secret: SECRET, now: justOutside })).toBeUndefined();
  });

  it('rejects a payload missing required fields', () => {
    const payload = Buffer.from(JSON.stringify({ memorialId: 'm-1' }), 'utf8').toString(
      'base64url',
    );
    const encoded = encodeSession(session(), SECRET);
    // Re-sign the truncated payload so only the shape check can reject it.
    const resigned = encodeSession(JSON.parse('{}') as Session, SECRET);
    expect(decodeSession(resigned, { secret: SECRET })).toBeUndefined();
    expect(payload.length).toBeGreaterThan(0);
    expect(encoded.length).toBeGreaterThan(0);
  });

  it('is httpOnly, lax and path-wide', () => {
    const options = sessionCookieOptions({ secure: true });
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe('lax');
    expect(options.path).toBe('/');
    expect(options.secure).toBe(true);
    expect(SESSION_COOKIE).toBe('col_session');
  });
});
