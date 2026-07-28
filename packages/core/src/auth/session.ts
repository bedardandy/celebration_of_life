/**
 * The session cookie.
 *
 * A magic link is redeemed once and exchanged for this: a small signed
 * statement of "who you are, on which memorial, in what role". It is httpOnly
 * so page scripts can never read it, and signed with HMAC-SHA256 so a person
 * cannot edit the memorial id in their cookie jar and land in someone else's
 * grief.
 *
 * It carries no secrets of its own — only ids — so the worst a leaked cookie
 * can do is what the magic link could already do, and revoking the participant
 * ends both.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { sessionSecret } from '../env';

export const SESSION_COOKIE = 'col_session';

/** Thirty days. Long enough that nobody is logged out mid-week by surprise. */
export const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 30;

export type SessionRole = 'organizer' | 'contributor';

export type Session = {
  participantId: string;
  memorialId: string;
  role: SessionRole;
  /** Epoch ms the session was minted. Used to expire it without a DB round trip. */
  issuedAt: number;
};

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function encodeSession(session: Session, secret: string = sessionSecret()): string {
  const payload = b64url(JSON.stringify(session));
  return `${payload}.${sign(payload, secret)}`;
}

/** Returns undefined for anything tampered with, malformed, or past its age. */
export function decodeSession(
  raw: string | undefined | null,
  options: { secret?: string; now?: number; maxAgeSec?: number } = {},
): Session | undefined {
  if (!raw) return undefined;
  const secret = options.secret ?? sessionSecret();
  const now = options.now ?? Date.now();
  const maxAgeSec = options.maxAgeSec ?? SESSION_MAX_AGE_SEC;

  const dot = raw.indexOf('.');
  if (dot <= 0 || dot === raw.length - 1) return undefined;
  const payload = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  if (!safeEqual(signature, sign(payload, secret))) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;

  const candidate = parsed as Partial<Session>;
  if (
    typeof candidate.participantId !== 'string' ||
    typeof candidate.memorialId !== 'string' ||
    (candidate.role !== 'organizer' && candidate.role !== 'contributor') ||
    typeof candidate.issuedAt !== 'number'
  ) {
    return undefined;
  }
  if (now - candidate.issuedAt > maxAgeSec * 1000) return undefined;

  return {
    participantId: candidate.participantId,
    memorialId: candidate.memorialId,
    role: candidate.role,
    issuedAt: candidate.issuedAt,
  };
}

export type SessionCookieOptions = {
  httpOnly: true;
  sameSite: 'lax';
  path: '/';
  secure: boolean;
  maxAge: number;
};

/**
 * `sameSite: 'lax'` rather than 'strict' on purpose: the session is set by a
 * top-level navigation from an email client, and 'strict' would drop it.
 */
export function sessionCookieOptions(
  options: { secure?: boolean; maxAgeSec?: number } = {},
): SessionCookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: options.secure ?? process.env['NODE_ENV'] === 'production',
    maxAge: options.maxAgeSec ?? SESSION_MAX_AGE_SEC,
  };
}
