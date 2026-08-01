/**
 * The Google Photos import, from the screen inwards.
 *
 * Two things are being protected here. The first is that an unconfigured
 * deployment shows nothing at all — no card, no teaser, and routes that answer
 * exactly as they would if they had never been written. The second is that the
 * round trip through Google's consent screen cannot be replayed or forged by
 * anybody other than the browser that started it.
 *
 * Every call to Google is a function in this file. Nothing here can reach the
 * network.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ReactElement } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const workdir = mkdtempSync(path.join(tmpdir(), 'col-google-test-'));
process.env['DATABASE_URL'] = `file:${path.join(workdir, 'google.db')}`;
process.env['STORAGE_DIR'] = path.join(workdir, 'blobs');
process.env['SESSION_SECRET'] = 'google-test-secret';
process.env['APP_BASE_URL'] = 'http://localhost:3000';

vi.mock('next/headers', async () => {
  const { nextHeadersMock } = await import('@/test/next-stubs');
  return nextHeadersMock();
});
vi.mock('next/cache', async () => {
  const { nextCacheMock } = await import('@/test/next-stubs');
  return nextCacheMock();
});

const { cookieJar, captureRedirect } = await import('@/test/next-stubs');
const { db } = await import('@/server/db');
const { createMemorialAction } = await import('./new/actions');
const { POST: startImport, GOOGLE_STATE_COOKIE } = await import('./api/import/google/start/route');
const { GET: googleCallback } = await import('./api/import/google/callback/route');
const PhotosPage = (await import('./m/[memorialId]/photos/page')).default;
const {
  DevConsoleTransport,
  SESSION_COOKIE,
  GOOGLE_PICKER_SCOPE,
  GOOGLE_STATE_PURPOSE,
  GOOGLE_TOKEN_PURPOSE,
  open,
  seal,
  setMailTransport,
} = await import('@col/core');
const { eq, jobs, listWhere } = await import('@col/db');

const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';

afterAll(() => {
  setMailTransport(undefined);
  rmSync(workdir, { recursive: true, force: true });
});

beforeAll(() => {
  setMailTransport(new DevConsoleTransport(() => {}));
  db();
});

beforeEach(() => {
  cookieJar.clear();
  configureGoogle(true);
});

afterEach(() => {
  configureGoogle(false);
  vi.unstubAllGlobals();
});

function configureGoogle(on: boolean): void {
  if (on) {
    process.env['GOOGLE_OAUTH_CLIENT_ID'] = CLIENT_ID;
    process.env['GOOGLE_OAUTH_CLIENT_SECRET'] = 'test-client-secret';
  } else {
    delete process.env['GOOGLE_OAUTH_CLIENT_ID'];
    delete process.env['GOOGLE_OAUTH_CLIENT_SECRET'];
  }
}

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

async function createMemorial(): Promise<{ memorialId: string; session: string }> {
  const destination = await captureRedirect(() =>
    createMemorialAction(
      {},
      form({
        decedentName: 'Ruth Kelleher',
        organizerName: 'Anne Kelleher',
        organizerEmail: `anne+${Math.random().toString(36).slice(2)}@example.test`,
      }),
    ),
  );
  const memorialId = destination.split('/')[2] as string;
  const session = cookieJar.get(SESSION_COOKIE)?.value as string;
  return { memorialId, session };
}

const signIn = (session: string) => cookieJar.set(SESSION_COOKIE, session);

/** Google, as a function. */
function fakeGoogle(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'ya29.test', expires_in: 3599 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('photospicker.googleapis.com/v1/sessions')) {
      return new Response(
        JSON.stringify({
          id: 'sess-42',
          pickerUri: 'https://photos.google.com/picker/sess-42',
          mediaItemsSet: false,
          pollingConfig: { pollInterval: '5s' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`unexpected call to ${url}`);
  }) as unknown as typeof fetch;
}

/* --- rendering a server component without a browser ----------------------- */

type Node = ReactElement | string | number | null | undefined | boolean | Node[];

function isElement(node: unknown): node is ReactElement {
  return typeof node === 'object' && node !== null && 'props' in node && 'type' in node;
}

const NOT_TEXT = new Set(['className', 'style', 'src', 'id', 'key', 'type', 'name', 'action']);
const CLIENT_COMPONENTS = new Set(['CopyBox']);

function textOf(node: Node): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (!isElement(node)) return '';

  const props = node.props as Record<string, unknown>;
  const type = node.type as unknown;
  if (typeof type === 'function') {
    const name =
      (type as { displayName?: string; name?: string }).displayName ??
      (type as { name?: string }).name ??
      '';
    if (!CLIENT_COMPONENTS.has(name)) {
      try {
        const rendered = (type as (p: unknown) => unknown)(props);
        if (!(rendered instanceof Promise)) return textOf(rendered as Node);
      } catch {
        /* needs a browser */
      }
    }
  }

  return Object.entries(props)
    .filter(([key]) => !NOT_TEXT.has(key))
    .map(([, value]) => textOf(value as Node))
    .join(' ');
}

const params = (memorialId: string) => Promise.resolve({ memorialId });
const search = (query: Record<string, string> = {}) => Promise.resolve(query);

/* -------------------------------------------------------------------------- */

describe('when Google is not configured', () => {
  it('renders nothing about it on the collect screen', async () => {
    const { memorialId, session } = await createMemorial();
    signIn(session);
    configureGoogle(false);

    const screen = await PhotosPage({ params: params(memorialId), searchParams: search() });
    const text = textOf(screen as Node);

    expect(text).not.toMatch(/Google Photos/i);
    // The rest of the screen is untouched: the family link is still the point.
    expect(text).toMatch(/Share this link with family/i);
  });

  it('answers the routes as though they were never written', async () => {
    const { memorialId, session } = await createMemorial();
    signIn(session);
    configureGoogle(false);

    const started = await startImport(
      new Request('http://localhost:3000/api/import/google/start', {
        method: 'POST',
        body: form({ memorialId }),
      }),
    );
    expect(started.status).toBe(404);

    const back = await googleCallback(
      new Request('http://localhost:3000/api/import/google/callback?code=x&state=y'),
    );
    expect(back.status).toBe(404);
  });
});

describe('when Google is configured', () => {
  it('offers it on the collect screen, in words about photos rather than accounts', async () => {
    const { memorialId, session } = await createMemorial();
    signIn(session);

    const screen = await PhotosPage({ params: params(memorialId), searchParams: search() });
    const text = textOf(screen as Node);

    expect(text).toMatch(/From Google Photos/);
    expect(text).toMatch(/only ever see the ones you pick/i);
  });

  it('sends the organiser to Google with one narrow scope and a sealed state', async () => {
    const { memorialId, session } = await createMemorial();
    signIn(session);

    const response = await startImport(
      new Request('http://localhost:3000/api/import/google/start', {
        method: 'POST',
        body: form({ memorialId }),
      }),
    );

    expect(response.status).toBe(303);
    const destination = new URL(response.headers.get('location') as string);
    expect(destination.origin + destination.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(destination.searchParams.get('scope')).toBe(GOOGLE_PICKER_SCOPE);
    expect(destination.searchParams.get('client_id')).toBe(CLIENT_ID);
    // No refresh token: this product has no business holding a durable key to
    // somebody's photo library.
    expect(destination.searchParams.get('access_type')).toBe('online');

    const state = destination.searchParams.get('state') as string;
    const opened = open<{ memorialId: string }>(GOOGLE_STATE_PURPOSE, state);
    expect(opened.ok && opened.value.memorialId).toBe(memorialId);
    // …and the same value is in the cookie, so a replay from elsewhere fails.
    const setCookie = response.headers
      .getSetCookie()
      .find((c) => c.startsWith(GOOGLE_STATE_COOKIE));
    expect(setCookie).toContain(`${GOOGLE_STATE_COOKIE}=${encodeURIComponent(state)}`);
    expect(setCookie).toContain('HttpOnly');
  });

  it('queues the import and hands the person to Google’s own picker', async () => {
    const { memorialId, session } = await createMemorial();
    signIn(session);
    vi.stubGlobal('fetch', fakeGoogle());

    const started = await startImport(
      new Request('http://localhost:3000/api/import/google/start', {
        method: 'POST',
        body: form({ memorialId }),
      }),
    );
    const state = new URL(started.headers.get('location') as string).searchParams.get(
      'state',
    ) as string;

    const back = await googleCallback(
      new Request(
        `http://localhost:3000/api/import/google/callback?code=auth-code&state=${encodeURIComponent(state)}`,
        { headers: { cookie: `${GOOGLE_STATE_COOKIE}=${state}` } },
      ),
    );

    expect(back.status).toBe(303);
    expect(back.headers.get('location')).toBe('https://photos.google.com/picker/sess-42');

    const queued = listWhere(db(), jobs, eq(jobs.memorialId, memorialId)).filter(
      (job) => job.type === 'import-google-photos',
    );
    expect(queued).toHaveLength(1);
    const payload = queued[0]?.payload as { sessionId: string; sealedToken: string };
    expect(payload.sessionId).toBe('sess-42');

    // The token is in the row, sealed, and openable only with our own key.
    expect(payload.sealedToken).not.toContain('ya29');
    const token = open<{ accessToken: string }>(GOOGLE_TOKEN_PURPOSE, payload.sealedToken);
    expect(token.ok && token.value.accessToken).toBe('ya29.test');

    // And the screen now says what is happening, without anybody waiting on it.
    const screen = await PhotosPage({ params: params(memorialId), searchParams: search() });
    expect(textOf(screen as Node)).toMatch(/bringing your photos over from Google/i);
  });

  it('refuses a state that did not come from this browser', async () => {
    const { memorialId, session } = await createMemorial();
    signIn(session);
    vi.stubGlobal('fetch', fakeGoogle());

    const forged = seal(
      GOOGLE_STATE_PURPOSE,
      { memorialId, participantId: 'someone', nonce: 'n' },
      { secret: 'a completely different secret' },
    );

    const back = await googleCallback(
      new Request(
        `http://localhost:3000/api/import/google/callback?code=auth-code&state=${encodeURIComponent(forged)}`,
        { headers: { cookie: `${GOOGLE_STATE_COOKIE}=${forged}` } },
      ),
    );

    expect(back.status).toBe(303);
    expect(back.headers.get('location')).toContain('/?google=again');
    expect(
      listWhere(db(), jobs, eq(jobs.memorialId, memorialId)).filter(
        (job) => job.type === 'import-google-photos',
      ),
    ).toHaveLength(0);
  });

  it('refuses a valid state replayed without the cookie that made it', async () => {
    const { memorialId, session } = await createMemorial();
    signIn(session);
    vi.stubGlobal('fetch', fakeGoogle());

    const started = await startImport(
      new Request('http://localhost:3000/api/import/google/start', {
        method: 'POST',
        body: form({ memorialId }),
      }),
    );
    const state = new URL(started.headers.get('location') as string).searchParams.get(
      'state',
    ) as string;

    const back = await googleCallback(
      new Request(
        `http://localhost:3000/api/import/google/callback?code=auth-code&state=${encodeURIComponent(state)}`,
      ),
    );

    expect(back.headers.get('location')).toContain('/?google=again');
  });

  it('treats "no thanks" on Google’s screen as a decision, not a failure', async () => {
    const { memorialId, session } = await createMemorial();
    signIn(session);

    const started = await startImport(
      new Request('http://localhost:3000/api/import/google/start', {
        method: 'POST',
        body: form({ memorialId }),
      }),
    );
    const state = new URL(started.headers.get('location') as string).searchParams.get(
      'state',
    ) as string;

    const back = await googleCallback(
      new Request(
        `http://localhost:3000/api/import/google/callback?error=access_denied&state=${encodeURIComponent(state)}`,
        { headers: { cookie: `${GOOGLE_STATE_COOKIE}=${state}` } },
      ),
    );

    expect(back.headers.get('location')).toContain(`/m/${memorialId}/photos?google=cancelled`);

    const screen = await PhotosPage({
      params: params(memorialId),
      searchParams: search({ google: 'cancelled' }),
    });
    const text = textOf(screen as Node);
    expect(text).toMatch(/nothing changed here/i);
    expect(text).not.toMatch(/error|failed|invalid/i);
  });
});
