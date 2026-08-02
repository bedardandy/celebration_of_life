/**
 * Finding their song by ear, headless.
 *
 * Three things are being protected here and none of them are the search box.
 *
 *   1. The screen still works when the catalogue does not. A family typing a
 *      song title at one in the morning must never meet an error wall, so every
 *      failure path is asserted to end in "type the name instead".
 *   2. Nothing plays that nobody asked for, and only one thing plays at a time.
 *   3. An audition leaves behind two strings and nothing else — no track row,
 *      no blob, no change to the timeline.
 *
 * The catalogue is mocked in every test in this file; nothing here touches the
 * network, and the fixture it answers with is the same one the core unit tests
 * read.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

const workdir = mkdtempSync(path.join(tmpdir(), 'col-audition-test-'));
process.env['DATABASE_URL'] = `file:${path.join(workdir, 'audition.db')}`;
process.env['STORAGE_DIR'] = path.join(workdir, 'blobs');
process.env['SESSION_SECRET'] = 'audition-test-secret';
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
const TheirSongPage = (await import('./m/[memorialId]/music/their-song/page')).default;
const { GET: searchSongs } = await import('./api/music/search/route');
const {
  applyAuditionChoice,
  auditionReducer,
  currentPreviewUrl,
  formatTrackLength,
  initialAuditionState,
} = await import('./m/[memorialId]/music/audition-state');

const {
  DevConsoleTransport,
  clearAuditionCache,
  currentSelection,
  latestProject,
  setMailTransport,
} = await import('@col/core');
const { listWhere, musicTracks } = await import('@col/db');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const dannyBoy = JSON.parse(
  readFileSync(path.join(repoRoot, 'fixtures', 'itunes', 'search-danny-boy.json'), 'utf8'),
);

beforeAll(() => {
  setMailTransport(new DevConsoleTransport(() => {}));
  db();
});

afterAll(() => {
  setMailTransport(undefined);
  rmSync(workdir, { recursive: true, force: true });
});

beforeEach(() => {
  cookieJar.clear();
  clearAuditionCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

async function signedInMemorial(): Promise<string> {
  const destination = await captureRedirect(() =>
    createMemorialAction(
      {},
      form({
        decedentName: 'Ruth Kelleher',
        organizerName: 'Anne Doyle',
        organizerEmail: `anne+${Math.random().toString(36).slice(2)}@example.test`,
      }),
    ),
  );
  return destination.split('/')[2] as string;
}

/** A stand-in catalogue. Nothing in this file is allowed to reach the real one. */
function catalogueAnswers(body: unknown = dannyBoy) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL) => {
    calls.push(String(url));
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'text/javascript; charset=utf-8' },
    });
  });
  vi.stubGlobal('fetch', fetchImpl);
  return { calls, fetchImpl };
}

function catalogueIsDown(problem: 'refused' | 'server-error' = 'refused') {
  const fetchImpl = vi.fn(async () => {
    if (problem === 'refused') throw new Error('connection refused');
    return new Response('upstream is unwell', { status: 503 });
  });
  vi.stubGlobal('fetch', fetchImpl);
  return fetchImpl;
}

const searchRequest = (q: string) =>
  new Request(`http://localhost/api/music/search?q=${encodeURIComponent(q)}`);

type Node = ReactElement | string | number | null | undefined | boolean | Node[];

function isElement(node: unknown): node is ReactElement {
  return typeof node === 'object' && node !== null && 'props' in node && 'type' in node;
}

const NOT_TEXT = new Set([
  'className',
  'style',
  'src',
  'id',
  'key',
  'type',
  'name',
  'action',
  'width',
  'height',
  'loading',
  'htmlFor',
]);

/** Client components need a browser; they contribute nothing to this, honestly. */
const CLIENT_COMPONENTS = new Set(['TapTempo', 'SongAudition', 'TrackPreview']);

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

function hrefsOf(node: Node, found: string[] = []): string[] {
  if (node == null || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    for (const child of node) hrefsOf(child, found);
    return found;
  }
  if (!isElement(node)) return found;
  const props = node.props as Record<string, unknown>;
  if (typeof props['href'] === 'string') found.push(props['href']);
  for (const [key, value] of Object.entries(props)) {
    if (key !== 'href') hrefsOf(value as Node, found);
  }
  return found;
}

/** Every element on the page, so a field can be found by its id. */
function elementsOf(node: Node, found: ReactElement[] = []): ReactElement[] {
  if (node == null || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    for (const child of node) elementsOf(child, found);
    return found;
  }
  if (!isElement(node)) return found;
  found.push(node);
  const props = node.props as Record<string, unknown>;
  const type = node.type as unknown;
  if (typeof type === 'function') {
    const name = (type as { name?: string }).name ?? '';
    if (!CLIENT_COMPONENTS.has(name)) {
      try {
        const rendered = (type as (p: unknown) => unknown)(props);
        if (!(rendered instanceof Promise)) elementsOf(rendered as Node, found);
      } catch {
        /* needs a browser */
      }
    }
  }
  for (const value of Object.values(props)) elementsOf(value as Node, found);
  return found;
}

const params = (memorialId: string) => Promise.resolve({ memorialId });
const search = (query: Record<string, string> = {}) => Promise.resolve(query);

/* -------------------------------------------------------------------------- */
/* the proxy                                                                   */
/* -------------------------------------------------------------------------- */

describe('the song search route', () => {
  it('is closed to anybody without an organizer session', async () => {
    catalogueAnswers();
    const response = await searchSongs(searchRequest('danny boy'));
    expect(response.status).toBe(403);
  });

  it('is closed to a session whose memorial no longer stands', async () => {
    const memorialId = await signedInMemorial();
    const { softDelete } = await import('@col/core');
    softDelete(db(), 'memorial', memorialId);
    catalogueAnswers();

    const response = await searchSongs(searchRequest('danny boy'));
    expect(response.status).toBe(403);
  });

  it('answers a signed-in organizer with versions they can listen to', async () => {
    await signedInMemorial();
    const { calls } = catalogueAnswers();

    const response = await searchSongs(searchRequest('danny boy'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');

    const body = (await response.json()) as { tracks: Array<Record<string, unknown>> };
    expect(body.tracks).toHaveLength(3);
    expect(body.tracks[0]?.['trackName']).toBe('Danny Boy');
    expect(body.tracks[0]?.['artistName']).toBe('Eva Cassidy');
    expect(body.tracks.every((track) => typeof track['previewUrl'] === 'string')).toBe(true);

    // One call, to Apple's keyless search endpoint, carrying only the words typed.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('https://itunes.apple.com/search');
    expect(calls[0]).toContain('term=danny+boy');
    expect(calls[0]).not.toContain(String(response.headers.get('set-cookie')));
    expect(calls[0]).not.toMatch(/memorial|session|key=/i);
  });

  it('says so quietly when the catalogue cannot be reached, and never 500s', async () => {
    await signedInMemorial();
    catalogueIsDown('refused');

    const response = await searchSongs(searchRequest('danny boy'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ unavailable: true });
  });

  it('says the same thing when the catalogue answers badly', async () => {
    await signedInMemorial();
    catalogueIsDown('server-error');

    const response = await searchSongs(searchRequest('danny boy'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ unavailable: true });
  });

  it('finds nothing gracefully rather than saying nothing at all', async () => {
    await signedInMemorial();
    catalogueAnswers({ resultCount: 0, results: [] });

    const response = await searchSongs(searchRequest('asdfgh'));
    expect(await response.json()).toEqual({ tracks: [] });
  });

  it('does not bother the catalogue about an empty box', async () => {
    await signedInMemorial();
    const { fetchImpl } = catalogueAnswers();

    const response = await searchSongs(new Request('http://localhost/api/music/search'));
    expect(await response.json()).toEqual({ tracks: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('asks once for the same words asked twice', async () => {
    await signedInMemorial();
    const { fetchImpl } = catalogueAnswers();

    await searchSongs(searchRequest('Danny Boy'));
    await searchSongs(searchRequest('  danny   boy  '));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps nothing: a search is not a track, a blob or a choice', async () => {
    const memorialId = await signedInMemorial();
    catalogueAnswers();
    await searchSongs(searchRequest('danny boy'));

    expect(listWhere(db(), musicTracks).some((row) => row.title.includes('Danny Boy'))).toBe(false);
    const project = latestProject(db(), memorialId);
    expect(project ? currentSelection(db(), project.id) : undefined).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* the screen                                                                  */
/* -------------------------------------------------------------------------- */

describe('the their-song screen', () => {
  it('invites a search but never requires one', async () => {
    const memorialId = await signedInMemorial();
    const page = (await TheirSongPage({
      params: params(memorialId),
      searchParams: search(),
    })) as Node;
    const text = textOf(page);

    expect(text).toContain('What was their song?');
    expect(text).toContain('listen to half a minute');
    expect(text).toContain('type the name yourself');
  });

  it('keeps the fields a person can simply type into, search or no search', async () => {
    const memorialId = await signedInMemorial();
    const page = (await TheirSongPage({
      params: params(memorialId),
      searchParams: search(),
    })) as Node;

    const ids = elementsOf(page)
      .map((element) => (element.props as Record<string, unknown>)['id'])
      .filter((id): id is string => typeof id === 'string');

    // The two fields the audition writes into are the same two fields that were
    // always there, and they are still on the page when the catalogue is not.
    expect(ids).toContain('title');
    expect(ids).toContain('artist');
    expect(textOf(page)).toContain('Which song will the room hear?');
  });

  it('hands the audition the ids of those fields, and nothing else', async () => {
    const memorialId = await signedInMemorial();
    const audition = elementsOf(
      (await TheirSongPage({ params: params(memorialId), searchParams: search() })) as Node,
    ).find((element) => (element.type as { name?: string })?.name === 'SongAudition');

    expect(audition).toBeDefined();
    expect(audition?.props).toEqual({ titleFieldId: 'title', artistFieldId: 'artist' });
  });

  it('explains how to rehearse, in words, and points at the venue card', async () => {
    const memorialId = await signedInMemorial();
    const page = (await TheirSongPage({
      params: params(memorialId),
      searchParams: search(),
    })) as Node;

    expect(textOf(page)).toContain('How to have a practice run');
    expect(textOf(page)).toContain('fades up from black');
    expect(textOf(page)).toContain('nobody will notice');
    expect(hrefsOf(page)).toContain(`/m/${memorialId}/deliver/timing-card`);
  });

  it('does not contradict what the room will hear', async () => {
    const memorialId = await signedInMemorial();
    const text = textOf(
      (await TheirSongPage({ params: params(memorialId), searchParams: search() })) as Node,
    );
    expect(text).toContain('The video will be silent');
    expect(text).toContain('never receive the recording');
  });
});

/* -------------------------------------------------------------------------- */
/* what plays, and when                                                        */
/* -------------------------------------------------------------------------- */

describe('the audition player', () => {
  const track = (id: string) => ({
    id,
    trackName: `Song ${id}`,
    artistName: 'A Singer',
    previewUrl: `https://preview.example/${id}.m4a`,
    explicit: false,
  });
  const tracks = [track('a'), track('b')];
  const withResults = auditionReducer(initialAuditionState, {
    type: 'search-answered',
    tracks,
  });

  it('starts silent, and stays silent until somebody presses something', () => {
    expect(initialAuditionState.playingId).toBeNull();
    expect(withResults.status).toBe('results');
    expect(withResults.playingId).toBeNull();
    expect(currentPreviewUrl(withResults)).toBeUndefined();
  });

  it('plays exactly one thing at a time', () => {
    const first = auditionReducer(withResults, { type: 'play', id: 'a' });
    expect(first.playingId).toBe('a');
    expect(currentPreviewUrl(first)).toBe('https://preview.example/a.m4a');

    const second = auditionReducer(first, { type: 'play', id: 'b' });
    expect(second.playingId).toBe('b');
    expect(currentPreviewUrl(second)).toBe('https://preview.example/b.m4a');
  });

  it('treats a second press on the same song as pause', () => {
    const playing = auditionReducer(withResults, { type: 'play', id: 'a' });
    expect(auditionReducer(playing, { type: 'play', id: 'a' }).playingId).toBeNull();
  });

  it('falls silent when a preview ends, is paused, or will not play', () => {
    const playing = auditionReducer(withResults, { type: 'play', id: 'a' });
    for (const type of ['ended', 'pause', 'audio-problem'] as const) {
      expect(auditionReducer(playing, { type }).playingId).toBeNull();
    }
  });

  it('stops the music when a new search starts, and when results change', () => {
    const playing = auditionReducer(withResults, { type: 'play', id: 'a' });
    expect(auditionReducer(playing, { type: 'search-started' }).playingId).toBeNull();
    expect(
      auditionReducer(playing, { type: 'search-answered', tracks: [track('c')] }).playingId,
    ).toBeNull();
  });

  it('knows the difference between nothing found and nowhere to ask', () => {
    const nothing = auditionReducer(withResults, { type: 'search-answered', tracks: [] });
    expect(nothing.status).toBe('nothing');

    const down = auditionReducer(withResults, { type: 'search-unavailable' });
    expect(down.status).toBe('unavailable');
    expect(down.tracks).toEqual([]);
    expect(down.playingId).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* what an audition leaves behind                                              */
/* -------------------------------------------------------------------------- */

describe('choosing one of the results', () => {
  it('fills in the two fields the organiser could have typed', () => {
    const title = { value: '' };
    const artist = { value: '' };
    applyAuditionChoice({ trackName: 'Danny Boy', artistName: 'Eva Cassidy' }, { title, artist });

    expect(title.value).toBe('Danny Boy');
    expect(artist.value).toBe('Eva Cassidy');
  });

  it('overwrites a wrong guess rather than appending to it', () => {
    const title = { value: 'Dany Boi' };
    const artist = { value: 'someone' };
    applyAuditionChoice({ trackName: 'Danny Boy', artistName: 'Johnny Cash' }, { title, artist });

    expect(title.value).toBe('Danny Boy');
    expect(artist.value).toBe('Johnny Cash');
  });

  it('leaves the artist field alone when there is nothing to put in it', () => {
    const artist = { value: 'The one from the kitchen radio' };
    applyAuditionChoice({ trackName: 'Danny Boy', artistName: '' }, { artist });
    expect(artist.value).toBe('The one from the kitchen radio');
  });

  it('does not fall over when a field is not on the page', () => {
    expect(() =>
      applyAuditionChoice({ trackName: 'Danny Boy', artistName: 'Eva Cassidy' }, {}),
    ).not.toThrow();
  });

  it('shows how long the song is, not how long the preview is', () => {
    expect(formatTrackLength(245026)).toBe('4:05');
    expect(formatTrackLength(60_000)).toBe('1:00');
    expect(formatTrackLength(0)).toBeUndefined();
    expect(formatTrackLength(undefined)).toBeUndefined();
  });
});
