/**
 * A sealed envelope for something we must carry but must not keep.
 *
 * Two things in the Google Photos import need this: the state that travels to
 * Google and back through the person's browser, and the access token that has
 * to reach the worker so it can download the photographs the person picked.
 *
 * Neither belongs in a database column. A column implies a lifetime, and the
 * lifetime of a credential for somebody's photo library should be "the next few
 * minutes". So both are AES-256-GCM envelopes keyed from `SESSION_SECRET`,
 * stamped with a purpose and an expiry, and opened exactly once by the code
 * that needs them. Rotating `SESSION_SECRET` invalidates every one of them,
 * which is the correct behaviour: an import in flight is a thing worth losing
 * to a rotated secret.
 *
 * The tradeoff, stated plainly because docs/google-photos.md has to state it
 * too: while an import job is queued, an encrypted token sits in the jobs
 * table. It is useless without the secret, it expires on its own, and the
 * handler blanks it the moment the import finishes. The alternative — the web
 * process downloading gigabytes of photographs inside a request — is worse for
 * a family on a bad connection.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { sessionSecret } from '../env';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

/** Purpose is mixed into the key, so a state cookie can never open a token. */
function keyFor(purpose: string, secret: string): Buffer {
  return createHash('sha256').update(`col:seal:${purpose}:${secret}`).digest();
}

export type SealOptions = {
  secret?: string;
  now?: number;
  /** How long the envelope is good for. Default five minutes. */
  ttlMs?: number;
};

export const DEFAULT_SEAL_TTL_MS = 5 * 60 * 1000;

/** Seal any JSON-serialisable value. The output is URL- and cookie-safe. */
export function seal<T>(purpose: string, value: T, options: SealOptions = {}): string {
  const now = options.now ?? Date.now();
  const expiresAt = now + (options.ttlMs ?? DEFAULT_SEAL_TTL_MS);
  const plaintext = Buffer.from(JSON.stringify({ v: value, exp: expiresAt }), 'utf8');

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, keyFor(purpose, options.secret ?? sessionSecret()), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
}

export type OpenResult<T> =
  | { ok: true; value: T }
  /** 'tampered' covers a wrong key, a wrong purpose and an edited byte alike. */
  | { ok: false; reason: 'tampered' | 'expired' | 'malformed' };

export function open<T>(
  purpose: string,
  sealed: string | undefined | null,
  options: SealOptions = {},
): OpenResult<T> {
  if (!sealed) return { ok: false, reason: 'malformed' };
  const parts = sealed.split('.');
  if (parts.length !== 4) return { ok: false, reason: 'malformed' };
  const [version, ivRaw, tagRaw, bodyRaw] = parts as [string, string, string, string];
  if (!constantTimeEquals(version, VERSION)) return { ok: false, reason: 'malformed' };

  let decrypted: Buffer;
  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      keyFor(purpose, options.secret ?? sessionSecret()),
      Buffer.from(ivRaw, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
    decrypted = Buffer.concat([
      decipher.update(Buffer.from(bodyRaw, 'base64url')),
      decipher.final(),
    ]);
  } catch {
    // A forged or edited envelope, or one sealed for a different purpose. All
    // of them are the same answer: this did not come from us.
    return { ok: false, reason: 'tampered' };
  }

  let parsed: { v: T; exp: number };
  try {
    parsed = JSON.parse(decrypted.toString('utf8')) as { v: T; exp: number };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof parsed?.exp !== 'number') return { ok: false, reason: 'malformed' };
  if ((options.now ?? Date.now()) > parsed.exp) return { ok: false, reason: 'expired' };
  return { ok: true, value: parsed.v };
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
