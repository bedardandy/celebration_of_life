/**
 * Magic tokens: the only way anyone gets in.
 *
 * There are no passwords in this product. An organiser gets a link by email; a
 * contributor gets a capability URL from the organiser. Both are 32 random
 * bytes, and the database only ever holds the SHA-256 hash — so a copy of the
 * database is not a copy of everyone's access.
 *
 * Organiser login links are single-use: once redeemed they are exchanged for a
 * session cookie, and the link in the mailbox stops working. Contributor links
 * are the opposite — they are meant to keep working, because "this link keeps
 * working" is the promise we make to a cousin with photos on an old phone.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { eq, getById, insertOne, magicTokens, updateById, type Db, type MagicToken } from '@col/db';
import { absoluteUrl, sessionSecret } from '../env';

export const TOKEN_BYTES = 32;

export type TokenKind = 'organizer-login' | 'collection-link' | 'contributor' | 'watch';

/** Fourteen days. Long enough to survive a hard week; short enough to expire. */
export const ORGANIZER_LOGIN_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export function generateTokenValue(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

export type IssueTokenInput = {
  memorialId: string;
  participantId?: string | null;
  kind: TokenKind;
  scopes?: string[];
  /** Milliseconds from `now`. Omit for a link that does not expire on its own. */
  ttlMs?: number | null;
  maxUses?: number | null;
  now?: number;
};

export type IssuedToken = {
  /** The plaintext. This is the only moment it exists; we store only its hash. */
  token: string;
  row: MagicToken;
  url: string;
};

export function tokenUrl(kind: TokenKind, token: string): string {
  if (kind === 'watch') return absoluteUrl(`/w/${token}`);
  if (kind === 'contributor' || kind === 'collection-link') return absoluteUrl(`/c/${token}`);
  return absoluteUrl(`/auth/${token}`);
}

export function issueToken(db: Db, input: IssueTokenInput): IssuedToken {
  const now = input.now ?? Date.now();
  const token = generateTokenValue();
  const rows = db
    .insert(magicTokens)
    .values({
      memorialId: input.memorialId,
      participantId: input.participantId ?? null,
      tokenHash: hashToken(token),
      kind: input.kind,
      scopes: input.scopes ?? defaultScopes(input.kind),
      expiresAt: input.ttlMs == null ? null : now + input.ttlMs,
      maxUses: input.maxUses ?? defaultMaxUses(input.kind),
    })
    .returning()
    .all();
  const row = rows[0];
  if (!row) throw new Error('issueToken: insert returned no row');
  return { token, row, url: tokenUrl(input.kind, token) };
}

function defaultScopes(kind: TokenKind): string[] {
  if (kind === 'organizer-login') return ['organizer'];
  if (kind === 'contributor' || kind === 'collection-link') return ['upload', 'memory-note'];
  return ['watch'];
}

function defaultMaxUses(kind: TokenKind): number | null {
  // Single-use for login; contributor and watch links are meant to be reused.
  return kind === 'organizer-login' ? 1 : null;
}

/* -------------------------------------------------------------------------- */
/* shareable links                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A collection link has to be *shown again*.
 *
 * An organiser prints the QR code for the back of the order of service, loses
 * the text message, and comes back on Thursday wanting the same link — and the
 * link is on a printed card by then, so rotating it is not an option. Storing
 * only a hash, as we do for login links, makes that impossible.
 *
 * So shareable links are derived rather than random: the token is an HMAC of
 * the row id under a server-side secret. The database still holds only the
 * hash, and a stolen copy of the database still does not contain anybody's
 * link — the secret lives in the environment, not in the file. Rotating the
 * secret invalidates every shared link at once, which `recoverShareableToken`
 * reports rather than papering over.
 */
export function linkSecret(): string {
  return process.env['LINK_SECRET']?.trim() || sessionSecret();
}

export function derivedTokenValue(tokenId: string, secret: string = linkSecret()): string {
  return createHmac('sha256', `${secret}:collection-link`).update(tokenId).digest('base64url');
}

export type ShareableTokenKind = Exclude<TokenKind, 'organizer-login'>;

export type IssueShareableInput = {
  memorialId: string;
  kind: ShareableTokenKind;
  participantId?: string | null;
  scopes?: string[];
  /** Who the link is for, in the organiser's words. */
  label?: string | null;
  askTemplate?: string | null;
  askNote?: string | null;
  /** A gentle nudge date. Never an expiry: the link keeps working. */
  deadlineAt?: number | null;
  now?: number;
};

/** Issue a link the organiser can be shown again, today and next Thursday. */
export function issueShareableToken(db: Db, input: IssueShareableInput): IssuedToken {
  const created = insertOne(db, magicTokens, {
    memorialId: input.memorialId,
    participantId: input.participantId ?? null,
    // Replaced immediately below; the column is NOT NULL and unique, and the
    // token cannot be derived until the row has an id.
    tokenHash: hashToken(generateTokenValue()),
    kind: input.kind,
    scopes: input.scopes ?? defaultScopes(input.kind),
    expiresAt: null,
    maxUses: null,
    label: input.label ?? null,
    askTemplate: input.askTemplate ?? null,
    askNote: input.askNote ?? null,
    deadlineAt: input.deadlineAt ?? null,
  });

  const token = derivedTokenValue(created.id);
  const row = updateById(db, magicTokens, created.id, { tokenHash: hashToken(token) }) ?? created;
  return { token, row, url: tokenUrl(input.kind, token) };
}

/**
 * The plaintext for a link we issued, recomputed. Undefined when the secret has
 * changed since — the honest answer, so the screen can offer a fresh link
 * instead of showing one that will not open.
 */
export function recoverShareableToken(row: MagicToken): string | undefined {
  if (row.kind === 'organizer-login') return undefined;
  const token = derivedTokenValue(row.id);
  return hashesMatch(hashToken(token), row.tokenHash) ? token : undefined;
}

export function shareableTokenUrl(row: MagicToken): string | undefined {
  const token = recoverShareableToken(row);
  return token === undefined ? undefined : tokenUrl(row.kind, token);
}

export type TokenRejection = 'not-found' | 'expired' | 'revoked' | 'already-used' | 'wrong-kind';

export type TokenLookup =
  { ok: true; row: MagicToken } | { ok: false; reason: TokenRejection; row?: MagicToken };

/** Validate without consuming. Used for contributor links, which persist. */
export function inspectToken(
  db: Db,
  token: string,
  options: { now?: number; kind?: TokenKind } = {},
): TokenLookup {
  const now = options.now ?? Date.now();
  if (!token || token.length < 16) return { ok: false, reason: 'not-found' };

  const hash = hashToken(token);
  const rows = db.select().from(magicTokens).where(eq(magicTokens.tokenHash, hash)).limit(1).all();
  const row = rows[0];
  if (!row || !hashesMatch(row.tokenHash, hash)) return { ok: false, reason: 'not-found' };
  if (options.kind && row.kind !== options.kind) return { ok: false, reason: 'wrong-kind', row };
  if (row.revokedAt != null) return { ok: false, reason: 'revoked', row };
  if (row.expiresAt != null && row.expiresAt <= now) return { ok: false, reason: 'expired', row };
  if (row.maxUses != null && row.usedCount >= row.maxUses) {
    return { ok: false, reason: 'already-used', row };
  }
  return { ok: true, row };
}

/** Validate and consume one use. Returns the row as it stood before the bump. */
export function redeemToken(
  db: Db,
  token: string,
  options: { now?: number; kind?: TokenKind } = {},
): TokenLookup {
  const now = options.now ?? Date.now();
  const found = inspectToken(db, token, options);
  if (!found.ok) return found;
  const updated = updateById(db, magicTokens, found.row.id, {
    usedCount: found.row.usedCount + 1,
    lastUsedAt: now,
  });
  return { ok: true, row: updated ?? found.row };
}

export function revokeToken(
  db: Db,
  tokenId: string,
  at: number = Date.now(),
): MagicToken | undefined {
  return updateById(db, magicTokens, tokenId, { revokedAt: at });
}

export function getToken(db: Db, tokenId: string): MagicToken | undefined {
  return getById(db, magicTokens, tokenId);
}

/**
 * Contributor and watch links, resolved without being consumed. Phase 2 builds
 * the pages behind them; the resolution rule belongs with the rest of auth.
 */
export function resolveContributorToken(
  db: Db,
  token: string,
  options: { now?: number } = {},
): TokenLookup {
  const found = inspectToken(db, token, options);
  if (!found.ok) return found;
  if (found.row.kind === 'organizer-login') {
    return { ok: false, reason: 'wrong-kind', row: found.row };
  }
  return found;
}

/** Plain, non-blaming wording for each way a link can fail. */
export const TOKEN_REJECTION_MESSAGE: Record<TokenRejection, string> = {
  'not-found': 'We could not find that link. It may have been copied incompletely.',
  expired: 'That link has expired. We can send you a new one.',
  revoked: 'That link has been turned off. We can send you a new one.',
  'already-used': 'That link has already been used. We can send you a new one.',
  'wrong-kind': 'That link does not open this page.',
};
