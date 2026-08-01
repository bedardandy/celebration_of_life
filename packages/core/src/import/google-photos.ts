/**
 * Bringing photographs across from Google Photos.
 *
 * Half a family's pictures live in Google Photos, and the person organising a
 * funeral is not going to download four hundred files to a laptop and upload
 * them again. So this exists — and it is deliberately the smallest thing that
 * can work.
 *
 * **Why the Picker API and not the Library API.** Google closed the Library
 * API's read scopes to third-party apps in March 2025: an app can now only see
 * what a person explicitly hands it in Google's own picker. That is a better
 * shape for this product anyway. We never browse anybody's library; a person
 * chooses photographs in Google's interface, and we receive exactly those.
 *
 * **The flow**, which is unusual and worth reading once:
 *   1. OAuth for one narrow scope (`photospicker.mediaitems.readonly`).
 *   2. Create a *session*. Google gives back a `pickerUri` and a polling config.
 *   3. Send the person to that URI. They pick photographs in Google's UI.
 *   4. Poll the session until `mediaItemsSet` turns true.
 *   5. List the picked items, and download each one's `baseUrl` **immediately** —
 *      those URLs expire in about an hour, and the session itself expires too.
 *   6. Hand the bytes to the ordinary upload path, so a photograph from Google
 *      is indistinguishable from a photograph from a cousin's phone: same
 *      `recordUpload`, same ingest job, same curation grid.
 *
 * Everything here is `fetch` and nothing else. No SDK: this is six HTTP calls,
 * and an SDK would be a dependency to keep current for the life of the product.
 * Every function takes an injectable `fetchImpl`, and no test in this repo ever
 * reaches the network.
 */

/* -------------------------------------------------------------------------- */
/* configuration                                                               */
/* -------------------------------------------------------------------------- */

export const GOOGLE_PICKER_SCOPE =
  'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';

export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_PICKER_API = 'https://photospicker.googleapis.com/v1';

/** Where Google sends the person back to. Must match the console exactly. */
export const GOOGLE_CALLBACK_PATH = '/api/import/google/callback';

/**
 * The two sealed envelopes this flow uses, named here so the web routes and the
 * worker cannot drift apart. Purposes are mixed into the key, so a state seal
 * can never be opened as a token — which is the point of having two.
 */
export const GOOGLE_STATE_PURPOSE = 'google-import-state';
export const GOOGLE_TOKEN_PURPOSE = 'google-import-token';

/** Ten minutes to get through Google's consent screen; an hour for a token. */
export const GOOGLE_STATE_TTL_MS = 10 * 60 * 1000;
export const GOOGLE_TOKEN_TTL_MS = 60 * 60 * 1000;

/** What travels to Google and back, sealed, through the person's browser. */
export type GoogleImportState = {
  memorialId: string;
  participantId: string;
  nonce: string;
};

export type GooglePhotosConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

/**
 * The whole feature is behind these two variables. Unset means the card never
 * renders, the routes 404, and nobody is told about a thing they cannot have.
 */
export function googlePhotosConfig(
  env: NodeJS.ProcessEnv = process.env,
  baseUrl?: string,
): GooglePhotosConfig | undefined {
  const clientId = env['GOOGLE_OAUTH_CLIENT_ID']?.trim();
  const clientSecret = env['GOOGLE_OAUTH_CLIENT_SECRET']?.trim();
  if (!clientId || !clientSecret) return undefined;
  const origin = (env['APP_BASE_URL']?.trim() || baseUrl || '').replace(/\/+$/, '');
  return {
    clientId,
    clientSecret,
    redirectUri: `${origin}${GOOGLE_CALLBACK_PATH}`,
  };
}

export function googleImportConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return googlePhotosConfig(env) !== undefined;
}

/* -------------------------------------------------------------------------- */
/* errors                                                                      */
/* -------------------------------------------------------------------------- */

export class GoogleImportError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'GoogleImportError';
  }
}

type Fetcher = typeof fetch;

async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  return text.slice(0, 400);
}

/* -------------------------------------------------------------------------- */
/* OAuth                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `access_type=online` on purpose: we never want a refresh token. This product
 * has no business holding a durable key to somebody's photo library, and an
 * import that has to be started again next week is a small price for that.
 */
export function authorizeUrl(config: GooglePhotosConfig, state: string): string {
  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_PICKER_SCOPE);
  url.searchParams.set('state', state);
  url.searchParams.set('access_type', 'online');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

export type GoogleToken = {
  accessToken: string;
  /** Epoch ms. Google's tokens are good for about an hour. */
  expiresAt: number;
  scope?: string;
};

export async function exchangeCodeForToken(input: {
  config: GooglePhotosConfig;
  code: string;
  fetchImpl?: Fetcher;
  now?: number;
}): Promise<GoogleToken> {
  const doFetch = input.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    code: input.code,
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
    redirect_uri: input.config.redirectUri,
    grant_type: 'authorization_code',
  });

  const response = await doFetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!response.ok) {
    throw new GoogleImportError(
      'Google did not complete the sign-in.',
      response.status,
      await readError(response),
    );
  }

  const json = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!json.access_token) {
    throw new GoogleImportError('Google did not return a way in.', response.status);
  }
  return {
    accessToken: json.access_token,
    expiresAt: (input.now ?? Date.now()) + (json.expires_in ?? 3600) * 1000,
    ...(json.scope ? { scope: json.scope } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* picker sessions                                                             */
/* -------------------------------------------------------------------------- */

export type PickerSession = {
  id: string;
  /** Where the person picks their photographs. Google's page, not ours. */
  pickerUri: string;
  /** True once they have finished picking. */
  mediaItemsSet: boolean;
  /** Seconds Google asks us to wait between polls. */
  pollIntervalSec: number;
  /** Epoch ms after which the session is gone. */
  expiresAt?: number;
};

/** Google returns durations as "5s" and timestamps as RFC 3339. */
function seconds(value: unknown, fallback: number): number {
  if (typeof value !== 'string') return fallback;
  const parsed = Number.parseFloat(value.replace(/s$/, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseSession(raw: Record<string, unknown>): PickerSession {
  const polling = (raw['pollingConfig'] ?? {}) as Record<string, unknown>;
  const expire = typeof raw['expireTime'] === 'string' ? Date.parse(raw['expireTime']) : NaN;
  return {
    id: String(raw['id'] ?? '').replace(/^sessions\//, ''),
    pickerUri: String(raw['pickerUri'] ?? ''),
    mediaItemsSet: raw['mediaItemsSet'] === true,
    pollIntervalSec: seconds(polling['pollInterval'], 5),
    ...(Number.isFinite(expire) ? { expiresAt: expire } : {}),
  };
}

async function pickerCall(
  path: string,
  accessToken: string,
  init: RequestInit,
  fetchImpl?: Fetcher,
): Promise<Record<string, unknown>> {
  const doFetch = fetchImpl ?? fetch;
  const response = await doFetch(`${GOOGLE_PICKER_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  if (!response.ok) {
    throw new GoogleImportError(
      'Google Photos did not answer.',
      response.status,
      await readError(response),
    );
  }
  if (response.status === 204) return {};
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

export async function createPickerSession(input: {
  accessToken: string;
  fetchImpl?: Fetcher;
}): Promise<PickerSession> {
  const raw = await pickerCall(
    '/sessions',
    input.accessToken,
    { method: 'POST', body: '{}' },
    input.fetchImpl,
  );
  const session = parseSession(raw);
  if (!session.id || !session.pickerUri) {
    throw new GoogleImportError('Google did not open a picking session.');
  }
  return session;
}

export async function getPickerSession(input: {
  accessToken: string;
  sessionId: string;
  fetchImpl?: Fetcher;
}): Promise<PickerSession> {
  const raw = await pickerCall(
    `/sessions/${encodeURIComponent(input.sessionId)}`,
    input.accessToken,
    { method: 'GET' },
    input.fetchImpl,
  );
  return parseSession(raw);
}

/**
 * Tidy up after ourselves. Failure here is not worth telling anybody about —
 * the session expires on its own — so it is swallowed deliberately.
 */
export async function deletePickerSession(input: {
  accessToken: string;
  sessionId: string;
  fetchImpl?: Fetcher;
}): Promise<void> {
  try {
    await pickerCall(
      `/sessions/${encodeURIComponent(input.sessionId)}`,
      input.accessToken,
      { method: 'DELETE' },
      input.fetchImpl,
    );
  } catch {
    /* the session expires on its own */
  }
}

export type PollOptions = {
  accessToken: string;
  sessionId: string;
  fetchImpl?: Fetcher;
  /** Give up after this long. Default twenty minutes — people take their time. */
  timeoutMs?: number;
  /** Injected in tests; production sleeps. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Called between polls so a worker can renew its lease. */
  onWait?: (session: PickerSession) => void;
};

export const DEFAULT_PICK_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Wait for the person to finish picking.
 *
 * They are in another tab, choosing photographs of their mother. That can take
 * twenty minutes and it should be allowed to: this waits patiently, at the
 * interval Google asks for, and gives up with a sentence rather than an error
 * page.
 */
export async function waitForPickedItems(options: PollOptions): Promise<PickerSession> {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = now() + (options.timeoutMs ?? DEFAULT_PICK_TIMEOUT_MS);

  for (;;) {
    const session = await getPickerSession({
      accessToken: options.accessToken,
      sessionId: options.sessionId,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    if (session.mediaItemsSet) return session;
    if (now() >= deadline) {
      throw new GoogleImportError(
        'Nothing was picked in time. Starting again is all it takes — nothing was lost.',
      );
    }
    options.onWait?.(session);
    await sleep(Math.max(1_000, session.pollIntervalSec * 1000));
  }
}

/* -------------------------------------------------------------------------- */
/* picked items                                                                */
/* -------------------------------------------------------------------------- */

export type PickedItem = {
  id: string;
  /** Expires within the hour. Download immediately, never store. */
  baseUrl: string;
  mimeType: string;
  filename: string;
  isVideo: boolean;
  /** Epoch ms the photograph was taken, when Google knows. */
  createdAt?: number;
};

function parseItem(raw: Record<string, unknown>): PickedItem | undefined {
  const file = (raw['mediaFile'] ?? {}) as Record<string, unknown>;
  const baseUrl = typeof file['baseUrl'] === 'string' ? file['baseUrl'] : '';
  if (!baseUrl) return undefined;
  const created = typeof raw['createTime'] === 'string' ? Date.parse(raw['createTime']) : NaN;
  const mime = typeof file['mimeType'] === 'string' ? file['mimeType'] : 'image/jpeg';
  return {
    id: String(raw['id'] ?? ''),
    baseUrl,
    mimeType: mime,
    filename: typeof file['filename'] === 'string' ? file['filename'] : 'photo.jpg',
    isVideo: raw['type'] === 'VIDEO' || mime.startsWith('video/'),
    ...(Number.isFinite(created) ? { createdAt: created } : {}),
  };
}

export async function listPickedItems(input: {
  accessToken: string;
  sessionId: string;
  pageToken?: string;
  pageSize?: number;
  fetchImpl?: Fetcher;
}): Promise<{ items: PickedItem[]; nextPageToken?: string }> {
  const query = new URLSearchParams({
    sessionId: input.sessionId,
    pageSize: String(input.pageSize ?? 100),
  });
  if (input.pageToken) query.set('pageToken', input.pageToken);

  const raw = await pickerCall(
    `/mediaItems?${query.toString()}`,
    input.accessToken,
    { method: 'GET' },
    input.fetchImpl,
  );
  const items = Array.isArray(raw['mediaItems'])
    ? (raw['mediaItems'] as Record<string, unknown>[])
        .map(parseItem)
        .filter((item): item is PickedItem => item !== undefined)
    : [];
  const next = typeof raw['nextPageToken'] === 'string' ? raw['nextPageToken'] : undefined;
  return { items, ...(next ? { nextPageToken: next } : {}) };
}

/** Every page, bounded so a runaway `nextPageToken` cannot loop forever. */
export async function listAllPickedItems(input: {
  accessToken: string;
  sessionId: string;
  fetchImpl?: Fetcher;
  maxItems?: number;
}): Promise<PickedItem[]> {
  const max = input.maxItems ?? 1_000;
  const out: PickedItem[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < 50; page += 1) {
    const result = await listPickedItems({
      accessToken: input.accessToken,
      sessionId: input.sessionId,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      ...(pageToken ? { pageToken } : {}),
    });
    out.push(...result.items);
    if (out.length >= max || !result.nextPageToken) break;
    pageToken = result.nextPageToken;
  }
  return out.slice(0, max);
}

export type DownloadResult =
  | { ok: true; bytes: Buffer; mime: string }
  /** 'expired' is the one that matters: baseUrls die about an hour after listing. */
  | { ok: false; reason: 'expired' | 'too-large' | 'unreadable'; status?: number };

/**
 * The bytes themselves.
 *
 * `=d` asks for the original file rather than a resized preview — a memorial
 * slideshow is the one place where the full-resolution copy is worth having.
 * Videos need `=dv`.
 */
export async function downloadPickedItem(input: {
  accessToken: string;
  item: PickedItem;
  fetchImpl?: Fetcher;
  maxBytes?: number;
}): Promise<DownloadResult> {
  const doFetch = input.fetchImpl ?? fetch;
  const url = `${input.item.baseUrl}=${input.item.isVideo ? 'dv' : 'd'}`;

  let response: Response;
  try {
    response = await doFetch(url, {
      headers: { authorization: `Bearer ${input.accessToken}` },
    });
  } catch {
    return { ok: false, reason: 'unreadable' };
  }

  if (!response.ok) {
    // 403/404 from a baseUrl means the link has gone stale, which is Google's
    // documented behaviour and not anybody's mistake.
    const expired = response.status === 403 || response.status === 404 || response.status === 410;
    return { ok: false, reason: expired ? 'expired' : 'unreadable', status: response.status };
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength === 0) return { ok: false, reason: 'unreadable' };
  if (input.maxBytes && buffer.byteLength > input.maxBytes) {
    return { ok: false, reason: 'too-large' };
  }
  return {
    ok: true,
    bytes: buffer,
    mime: response.headers.get('content-type')?.split(';')[0]?.trim() || input.item.mimeType,
  };
}

/* -------------------------------------------------------------------------- */
/* what the family reads                                                       */
/* -------------------------------------------------------------------------- */

export type ImportTally = { added: number; expired: number; skipped: number; total: number };

/**
 * The summary, in one sentence, telling the truth including when the truth is
 * partial. Google's links expire; when two of twenty do, the family is told
 * exactly that and exactly what fixes it — not "an error occurred".
 */
export function importSummary(tally: ImportTally): string {
  if (tally.total === 0) {
    return 'Nothing was picked that time. You can go back to Google Photos and choose again.';
  }
  if (tally.added === 0) {
    return (
      'None of them came through — Google let the links expire before we could fetch them. ' +
      'Picking them again usually works, and nothing else was affected.'
    );
  }
  if (tally.added === tally.total) {
    const noun = tally.added === 1 ? 'photo' : 'photos';
    return `All ${tally.added} ${noun} came over. They are with the rest now.`;
  }

  const parts: string[] = [`We brought over ${tally.added} of ${tally.total}`];
  if (tally.expired > 0) {
    parts.push(
      `Google let ${tally.expired} ${tally.expired === 1 ? 'link' : 'links'} expire; ` +
        `pick ${tally.expired === 1 ? 'it' : 'them'} again and ${
          tally.expired === 1 ? 'it' : 'they'
        } will come through`,
    );
  }
  if (tally.skipped > 0) {
    parts.push(`${tally.skipped} ${tally.skipped === 1 ? 'was' : 'were'} not a photo or a video`);
  }
  return `${parts.join(' — ')}.`;
}

/** While the job is queued or running. */
export function importInProgressLine(count?: number): string {
  if (!count) return "We're bringing your photos over from Google. You do not need to wait here.";
  return `We're bringing over your ${count} ${count === 1 ? 'photo' : 'photos'}. You do not need to wait here.`;
}
