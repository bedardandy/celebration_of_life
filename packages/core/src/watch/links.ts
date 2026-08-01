/**
 * Private viewing links.
 *
 * Not everybody can be in the room. A brother in another country, a colleague
 * who could not travel, a grandchild too small to sit through it — the family
 * wants to send them the video, and the way people send video is a link.
 *
 * So this is a capability URL like a collection link, and for the same reasons:
 * no account, no password, works on a phone that has never heard of us. It is
 * derived rather than random (an HMAC of the row id) so the organiser can be
 * shown it again next Thursday, hashed in the database, scoped to 'watch', and
 * revocable in one press. Whether the link may also *download* the file is a
 * second decision, kept as a scope on the same row.
 *
 * What a watch link can never do: reach another family's video, reach a render
 * that has not finished, or survive the organiser turning it off.
 */
import {
  desc,
  eq,
  getById,
  magicTokens,
  memorials,
  renderJobs,
  updateById,
  type Db,
  type MagicToken,
  type Memorial,
  type RenderJob,
} from '@col/db';
import type { RenderPreset } from '@col/schemas';
import {
  inspectToken,
  issueShareableToken,
  recoverShareableToken,
  revokeToken,
  tokenUrl,
  type TokenRejection,
} from '../auth/tokens';

/** Watching is the base capability; downloading is granted on top of it. */
export const WATCH_SCOPE = 'watch';
export const DOWNLOAD_SCOPE = 'download';

/**
 * Which finished render a viewing link should play, best first.
 *
 * The 1080p file is the artifact of record. The 720p backup is the same video
 * and streams more kindly on a phone, so it is a perfectly good second. A draft
 * is last and is labelled as one on the page — a family who has only made a
 * quick preview should still be able to show somebody something.
 */
export const WATCHABLE_PRESET_ORDER: RenderPreset[] = ['final1080', 'backup720', 'draft360'];

export type WatchLink = {
  row: MagicToken;
  /** Undefined when the link secret changed and the link cannot be shown again. */
  url?: string;
  token?: string;
  active: boolean;
  allowDownload: boolean;
  /** Who the organiser said it was for. Optional, and usually blank. */
  label?: string;
};

/* -------------------------------------------------------------------------- */
/* issuing                                                                     */
/* -------------------------------------------------------------------------- */

function scopesFor(allowDownload: boolean): string[] {
  return allowDownload ? [WATCH_SCOPE, DOWNLOAD_SCOPE] : [WATCH_SCOPE];
}

export type CreateWatchLinkInput = {
  memorialId: string;
  label?: string | null;
  /** Off by default: sharing a video and handing over the file are different acts. */
  allowDownload?: boolean;
};

export function createWatchLink(db: Db, input: CreateWatchLinkInput): WatchLink {
  const issued = issueShareableToken(db, {
    memorialId: input.memorialId,
    kind: 'watch',
    scopes: scopesFor(input.allowDownload === true),
    label: input.label?.trim() || null,
  });
  return describeWatchLink(issued.row);
}

/**
 * One live viewing link per memorial unless the organiser asks for another.
 *
 * The deliver screen calls this, so "share a private viewing link" is one press
 * and not two, and pressing it twice does not scatter links a family then has
 * to reason about.
 */
export function ensureWatchLink(db: Db, memorialId: string): WatchLink {
  const existing = listWatchLinks(db, memorialId).find((link) => link.active);
  return existing ?? createWatchLink(db, { memorialId });
}

export function describeWatchLink(row: MagicToken): WatchLink {
  const token = recoverShareableToken(row);
  return {
    row,
    ...(token ? { token, url: tokenUrl('watch', token) } : {}),
    active: row.revokedAt == null,
    allowDownload: row.scopes.includes(DOWNLOAD_SCOPE),
    ...(row.label ? { label: row.label } : {}),
  };
}

export function listWatchLinks(db: Db, memorialId: string): WatchLink[] {
  return db
    .select()
    .from(magicTokens)
    .where(eq(magicTokens.memorialId, memorialId))
    .orderBy(desc(magicTokens.createdAt))
    .all()
    .filter((row) => row.kind === 'watch')
    .map(describeWatchLink);
}

export function revokeWatchLink(db: Db, memorialId: string, tokenId: string): boolean {
  const row = getById(db, magicTokens, tokenId);
  if (!row || row.memorialId !== memorialId || row.kind !== 'watch') return false;
  return revokeToken(db, tokenId) !== undefined;
}

/** "Let them save a copy" — a toggle, not a new link, so nothing needs resending. */
export function setWatchDownload(
  db: Db,
  memorialId: string,
  tokenId: string,
  allowDownload: boolean,
): WatchLink | undefined {
  const row = getById(db, magicTokens, tokenId);
  if (!row || row.memorialId !== memorialId || row.kind !== 'watch') return undefined;
  const updated = updateById(db, magicTokens, tokenId, { scopes: scopesFor(allowDownload) });
  return updated ? describeWatchLink(updated) : undefined;
}

/* -------------------------------------------------------------------------- */
/* what there is to watch                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The finished file a viewing link should play, or nothing.
 *
 * "Finished" means the render row said done *and* kept a blob key — which in
 * this product means ffprobe agreed the file plays. A render that is still
 * running is not a video with a progress bar on it; it is a page that says the
 * video is not ready yet.
 */
export function watchableRender(
  db: Db,
  memorialId: string,
  cut: 'service' | 'family' = 'service',
): RenderJob | undefined {
  const done = db
    .select()
    .from(renderJobs)
    .where(eq(renderJobs.memorialId, memorialId))
    .orderBy(desc(renderJobs.createdAt))
    .limit(60)
    .all()
    .filter((row) => row.status === 'done' && row.outputBlobKey != null);

  for (const preset of WATCHABLE_PRESET_ORDER) {
    const match = done.find((row) => row.preset === preset && row.cut === cut);
    if (match) return match;
  }
  for (const preset of WATCHABLE_PRESET_ORDER) {
    const match = done.find((row) => row.preset === preset);
    if (match) return match;
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* arriving                                                                    */
/* -------------------------------------------------------------------------- */

export type WatchContext = {
  token: MagicToken;
  memorial: Memorial;
  allowDownload: boolean;
  /** The finished video, when there is one. */
  render?: RenderJob;
};

export type WatchResolution =
  { ok: true; context: WatchContext } | { ok: false; reason: TokenRejection | 'gone' };

/**
 * Turn a viewing link into a page. Never consumes a use: a link that stops
 * working the second time somebody opens it is a link that has broken.
 */
export function resolveWatchToken(
  db: Db,
  token: string,
  options: { now?: number } = {},
): WatchResolution {
  const found = inspectToken(db, token, options);
  if (!found.ok) return { ok: false, reason: found.reason };
  const row = found.row;
  if (row.kind !== 'watch') return { ok: false, reason: 'wrong-kind' };

  const memorial = getById(db, memorials, row.memorialId);
  if (!memorial || memorial.deletedAt != null) return { ok: false, reason: 'gone' };

  const render = watchableRender(db, memorial.id);
  return {
    ok: true,
    context: {
      token: row,
      memorial,
      allowDownload: row.scopes.includes(DOWNLOAD_SCOPE),
      ...(render ? { render } : {}),
    },
  };
}

/**
 * May this token see this particular render? Asked by the streaming route,
 * which is handed a render id from the URL and must not take it on trust.
 */
export function watchTokenAllows(
  db: Db,
  token: string,
  renderJob: RenderJob,
  options: { now?: number; forDownload?: boolean } = {},
): boolean {
  const found = inspectToken(db, token, options);
  if (!found.ok || found.row.kind !== 'watch') return false;
  if (found.row.memorialId !== renderJob.memorialId) return false;
  if (options.forDownload && !found.row.scopes.includes(DOWNLOAD_SCOPE)) return false;
  return true;
}

/* -------------------------------------------------------------------------- */
/* words                                                                       */
/* -------------------------------------------------------------------------- */

export const WATCH_LINK_HELP =
  'Anyone with this link can watch the video. There is no account and no sign-in. You can turn it off at any time.';

export const WATCH_DOWNLOAD_HELP =
  'Let people save their own copy. Turn this off if you would rather they only watched it here.';

export const WATCH_NOT_READY = {
  title: 'The video is not ready yet',
  body: 'The family is still putting it together. This link will keep working — try again later.',
};
