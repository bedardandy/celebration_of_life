/**
 * The Google Photos client, and the envelopes it travels in.
 *
 * Every request here is answered by a function in this file. The assertions are
 * about the two things that would actually hurt a family: a credential kept
 * somewhere it should not be, and photographs quietly going missing without
 * anybody being told.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, eq, jobs, listWhere, mediaAssets, memorials, insertOne } from '@col/db';
import {
  authorizeUrl,
  downloadPickedItem,
  exchangeCodeForToken,
  googleImportConfigured,
  googlePhotosConfig,
  importSummary,
  listAllPickedItems,
  waitForPickedItems,
  GOOGLE_PICKER_SCOPE,
  GoogleImportError,
  type PickedItem,
} from './google-photos';
import { runGooglePhotosImport } from './run';
import { open, seal } from './seal';

const SECRET = 'sealed-envelope-test-secret';

afterEach(() => {
  delete process.env['GOOGLE_OAUTH_CLIENT_ID'];
  delete process.env['GOOGLE_OAUTH_CLIENT_SECRET'];
  vi.useRealTimers();
});

const config = {
  clientId: 'client-id.apps.googleusercontent.com',
  clientSecret: 'secret',
  redirectUri: 'https://memorial.example/api/import/google/callback',
};

/* -------------------------------------------------------------------------- */

describe('the sealed envelope', () => {
  it('round-trips a value and refuses one sealed for another purpose', () => {
    const sealed = seal('token', { accessToken: 'ya29.x' }, { secret: SECRET });
    expect(sealed).not.toContain('ya29');

    const opened = open<{ accessToken: string }>('token', sealed, { secret: SECRET });
    expect(opened.ok && opened.value.accessToken).toBe('ya29.x');

    // A state cookie must never be able to open as a credential.
    expect(open('state', sealed, { secret: SECRET })).toEqual({ ok: false, reason: 'tampered' });
  });

  it('refuses a forged one, an edited one, and a stale one', () => {
    const sealed = seal('token', { a: 1 }, { secret: SECRET, ttlMs: 1_000 });

    expect(open('token', sealed, { secret: 'another secret' })).toEqual({
      ok: false,
      reason: 'tampered',
    });
    const edited = `${sealed.slice(0, -4)}zzzz`;
    expect(open('token', edited, { secret: SECRET }).ok).toBe(false);
    expect(open('token', sealed, { secret: SECRET, now: Date.now() + 5_000 })).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(open('token', undefined, { secret: SECRET })).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(open('token', 'not-an-envelope', { secret: SECRET })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});

describe('configuration', () => {
  it('is off until both variables are set', () => {
    expect(googleImportConfigured({})).toBe(false);
    expect(googleImportConfigured({ GOOGLE_OAUTH_CLIENT_ID: 'x' })).toBe(false);
    expect(
      googleImportConfigured({ GOOGLE_OAUTH_CLIENT_SECRET: 'y', GOOGLE_OAUTH_CLIENT_ID: 'x' }),
    ).toBe(true);
  });

  it('builds the redirect from APP_BASE_URL, which must match Google’s console', () => {
    const resolved = googlePhotosConfig({
      GOOGLE_OAUTH_CLIENT_ID: 'x',
      GOOGLE_OAUTH_CLIENT_SECRET: 'y',
      APP_BASE_URL: 'https://memorial.example/',
    });
    expect(resolved?.redirectUri).toBe('https://memorial.example/api/import/google/callback');
  });

  it('asks for one scope and no refresh token', () => {
    const url = new URL(authorizeUrl(config, 'sealed-state'));
    expect(url.searchParams.get('scope')).toBe(GOOGLE_PICKER_SCOPE);
    expect(url.searchParams.get('scope')).toContain('photospicker.mediaitems.readonly');
    expect(url.searchParams.get('access_type')).toBe('online');
    expect(url.searchParams.get('state')).toBe('sealed-state');
  });
});

describe('talking to Google', () => {
  it('exchanges a code for a short-lived token', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ access_token: 'ya29.x', expires_in: 3599 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const token = await exchangeCodeForToken({
      config,
      code: 'code',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: 1_000_000,
    });
    expect(token.accessToken).toBe('ya29.x');
    expect(token.expiresAt).toBe(1_000_000 + 3_599_000);

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(init.body)).toContain('grant_type=authorization_code');
  });

  it('says so plainly when Google refuses the sign-in', async () => {
    const fetchImpl = async () => new Response('bad code', { status: 400 });
    await expect(
      exchangeCodeForToken({ config, code: 'x', fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toBeInstanceOf(GoogleImportError);
  });

  it('waits for the person to finish picking, at the interval Google asks for', async () => {
    let polls = 0;
    const waits: number[] = [];
    const fetchImpl = (async () => {
      polls += 1;
      return new Response(
        JSON.stringify({
          id: 'sess-1',
          pickerUri: 'https://photos.google.com/picker/sess-1',
          mediaItemsSet: polls >= 3,
          pollingConfig: { pollInterval: '4s' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const session = await waitForPickedItems({
      accessToken: 'ya29.x',
      sessionId: 'sess-1',
      fetchImpl,
      sleep: async (ms) => void waits.push(ms),
    });

    expect(session.mediaItemsSet).toBe(true);
    expect(polls).toBe(3);
    expect(waits).toEqual([4_000, 4_000]);
  });

  it('gives up patiently rather than waiting forever', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ id: 's', pickerUri: 'p', mediaItemsSet: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    let clock = 0;
    await expect(
      waitForPickedItems({
        accessToken: 'x',
        sessionId: 's',
        fetchImpl,
        timeoutMs: 10_000,
        now: () => clock,
        sleep: async () => {
          clock += 60_000;
        },
      }),
    ).rejects.toThrow(/nothing was lost/i);
  });

  it('follows every page of picked items', async () => {
    const pages = [
      { mediaItems: [wireItem('a'), wireItem('b')], nextPageToken: 'p2' },
      { mediaItems: [wireItem('c')] },
    ];
    let call = 0;
    const fetchImpl = (async () => {
      const body = pages[call] ?? { mediaItems: [] };
      call += 1;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const items = await listAllPickedItems({ accessToken: 'x', sessionId: 's', fetchImpl });
    expect(items.map((i) => i.filename)).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
  });

  it('asks for the original file, and calls a 403 what it is', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(String(url));
      return String(url).includes('gone')
        ? new Response('expired', { status: 403 })
        : new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { 'content-type': 'image/jpeg' },
          });
    }) as unknown as typeof fetch;

    const ok = await downloadPickedItem({ accessToken: 'x', item: item('a'), fetchImpl });
    expect(ok.ok).toBe(true);
    expect(seen[0]).toMatch(/=d$/);

    const gone = await downloadPickedItem({
      accessToken: 'x',
      item: { ...item('gone'), baseUrl: 'https://lh3.example/gone' },
      fetchImpl,
    });
    expect(gone).toMatchObject({ ok: false, reason: 'expired', status: 403 });
  });
});

describe('what the family is told', () => {
  it('says exactly how many came, and what to do about the rest', () => {
    expect(importSummary({ added: 18, expired: 2, skipped: 0, total: 20 })).toBe(
      'We brought over 18 of 20 — Google let 2 links expire; pick them again and they will come through.',
    );
    expect(importSummary({ added: 20, expired: 0, skipped: 0, total: 20 })).toMatch(
      /All 20 photos came over/,
    );
    expect(importSummary({ added: 0, expired: 0, skipped: 0, total: 0 })).toMatch(
      /Nothing was picked/,
    );
    expect(importSummary({ added: 0, expired: 3, skipped: 0, total: 3 })).toMatch(
      /Picking them again usually works/,
    );
  });

  it('never uses a word that reads as blame', () => {
    const sentences = [
      importSummary({ added: 18, expired: 2, skipped: 0, total: 20 }),
      importSummary({ added: 0, expired: 2, skipped: 0, total: 2 }),
      importSummary({ added: 1, expired: 0, skipped: 1, total: 2 }),
    ];
    for (const sentence of sentences) {
      expect(sentence).not.toMatch(/error|failed|invalid|denied/i);
    }
  });
});

describe('the import itself', () => {
  it('files each photograph through the ordinary upload path', async () => {
    const db = createTestDb();
    const memorial = insertOne(db, memorials, { decedentName: 'Ruth Kelleher' });
    const put = vi.fn(async () => ({}));

    const fetchImpl = (async (url: string) => {
      const target = String(url);
      if (target.includes('/v1/sessions')) {
        return json({ id: 's', pickerUri: 'p', mediaItemsSet: true });
      }
      if (target.includes('/v1/mediaItems')) {
        return json({ mediaItems: [wireItem('a'), wireItem('b')] });
      }
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    }) as unknown as typeof fetch;

    const outcome = await runGooglePhotosImport(
      db,
      { put },
      { memorialId: memorial.id, sessionId: 's', accessToken: 'ya29.x', fetchImpl },
    );

    expect(outcome.tally).toEqual({ added: 2, expired: 0, skipped: 0, total: 2 });
    expect(put).toHaveBeenCalledTimes(2);
    expect(listWhere(db, mediaAssets, eq(mediaAssets.memorialId, memorial.id))).toHaveLength(2);
    // The same job a phone upload makes, so ingest is unaware of the difference.
    expect(listWhere(db, jobs, eq(jobs.type, 'ingest-asset'))).toHaveLength(2);
    db.$sqlite.close();
  });
});

/* -------------------------------------------------------------------------- */

function item(name: string): PickedItem {
  return {
    id: name,
    baseUrl: `https://lh3.example/${name}`,
    mimeType: 'image/jpeg',
    filename: `${name}.jpg`,
    isVideo: false,
  };
}

/** The shape Google actually sends, which is not the shape we work with. */
function wireItem(name: string): Record<string, unknown> {
  return {
    id: name,
    createTime: '1975-06-04T10:00:00Z',
    type: 'PHOTO',
    mediaFile: {
      baseUrl: `https://lh3.example/${name}`,
      mimeType: 'image/jpeg',
      filename: `${name}.jpg`,
    },
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
