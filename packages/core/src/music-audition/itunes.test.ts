/**
 * The song search, against captured JSON.
 *
 * The fixtures in `fixtures/itunes/` were written by hand to match the shape
 * iTunes Search returns — including the awkward parts: a row with no preview at
 * all, and a row flagged explicit. Nothing in this file reaches the network, and
 * the assertions are about the two things that would actually hurt on the day:
 * a family shown a version they cannot listen to, and a search box that turns
 * into an error wall when the catalogue is unreachable.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  AUDITION_RESULT_LIMIT,
  ITUNES_SEARCH_ENDPOINT,
  auditionSearch,
  buildItunesSearchUrl,
  clearAuditionCache,
  isAuditionUnavailable,
  mapItunesResponse,
  normaliseTerm,
  type AuditionCache,
} from './itunes';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(repoRoot, 'fixtures', 'itunes', name), 'utf8'));
}

const dannyBoy = fixture('search-danny-boy.json');
const nothingFound = fixture('search-nothing-found.json');

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    // iTunes really does serve JSON under this content type.
    headers: { 'content-type': 'text/javascript; charset=utf-8' },
  });

/* -------------------------------------------------------------------------- */
/* the request                                                                 */
/* -------------------------------------------------------------------------- */

describe('the search URL', () => {
  it('asks for music, eight at a time, with no key and no account', () => {
    const url = new URL(buildItunesSearchUrl('  Danny   Boy  '));
    expect(url.origin + url.pathname).toBe(ITUNES_SEARCH_ENDPOINT);
    expect(url.searchParams.get('media')).toBe('music');
    expect(url.searchParams.get('limit')).toBe(String(AUDITION_RESULT_LIMIT));
    expect(url.searchParams.get('term')).toBe('Danny Boy');
    // Nothing identifying travels with the query.
    expect(url.search).not.toMatch(/key|token|auth|memorial/i);
  });

  it('collapses whitespace and refuses to send an essay', () => {
    expect(normaliseTerm('\n the  long   goodbye \t')).toBe('the long goodbye');
    expect(normaliseTerm('x'.repeat(500)).length).toBeLessThanOrEqual(120);
  });
});

/* -------------------------------------------------------------------------- */
/* the response                                                                */
/* -------------------------------------------------------------------------- */

describe('mapping what comes back', () => {
  it('keeps what a person needs to recognise a recording', () => {
    const tracks = mapItunesResponse(dannyBoy);
    const first = tracks[0];

    expect(first?.trackName).toBe('Danny Boy');
    expect(first?.artistName).toBe('Eva Cassidy');
    expect(first?.collectionName).toBe('Songbird');
    expect(first?.previewUrl).toContain('audio-ssl.itunes.apple.com');
    expect(first?.artworkUrl100).toContain('100x100');
    expect(first?.durationMs).toBe(245026);
    expect(first?.id).toBe('1440920417');
  });

  it('drops the row with no preview, rather than showing a dead button', () => {
    const tracks = mapItunesResponse(dannyBoy);
    expect(tracks).toHaveLength(3);
    expect(tracks.every((track) => track.previewUrl.length > 0)).toBe(true);
    expect(tracks.some((track) => track.trackName === 'Danny Boy (Live)')).toBe(false);
  });

  it('passes the explicit flag through without hiding the song', () => {
    const tracks = mapItunesResponse(dannyBoy);
    const pogues = tracks.find((track) => track.artistName === 'The Pogues');
    // Their song is their song. We say so; we do not decide for them.
    expect(pogues).toBeDefined();
    expect(pogues?.explicit).toBe(true);
    expect(tracks.filter((track) => !track.explicit)).toHaveLength(2);
  });

  it('is empty, not broken, when nothing was found', () => {
    expect(mapItunesResponse(nothingFound)).toEqual([]);
  });

  it('is empty, not broken, when the body is not what we expected at all', () => {
    for (const payload of [null, undefined, 'a string', 42, {}, { results: 'nope' }]) {
      expect(mapItunesResponse(payload)).toEqual([]);
    }
  });

  it('skips half-written rows and never lists the same recording twice', () => {
    const tracks = mapItunesResponse({
      resultCount: 4,
      results: [
        { trackId: 1, trackName: 'A Song', artistName: 'A Singer', previewUrl: 'https://p/1.m4a' },
        { trackId: 1, trackName: 'A Song', artistName: 'A Singer', previewUrl: 'https://p/1.m4a' },
        { trackId: 2, trackName: '', artistName: 'A Singer', previewUrl: 'https://p/2.m4a' },
        { trackId: 3, artistName: 'A Singer', previewUrl: 'https://p/3.m4a' },
        null,
      ],
    });
    expect(tracks.map((track) => track.id)).toEqual(['1']);
  });
});

/* -------------------------------------------------------------------------- */
/* the search itself                                                           */
/* -------------------------------------------------------------------------- */

describe('searching', () => {
  const freshCache = (): AuditionCache => new Map();

  it('answers with songs when the catalogue answers', async () => {
    const result = await auditionSearch({
      term: 'danny boy',
      cache: freshCache(),
      fetchImpl: (async () => jsonResponse(dannyBoy)) as unknown as typeof fetch,
    });
    expect(isAuditionUnavailable(result)).toBe(false);
    expect(!isAuditionUnavailable(result) && result.tracks).toHaveLength(3);
  });

  it('does not ask anybody anything about an empty box', async () => {
    const fetchImpl = vi.fn();
    const result = await auditionSearch({
      term: '   ',
      cache: freshCache(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ tracks: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('asks once for the same words typed twice', async () => {
    const cache = freshCache();
    const fetchImpl = vi.fn(async () => jsonResponse(dannyBoy));

    await auditionSearch({
      term: 'Danny Boy',
      cache,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await auditionSearch({
      term: '  danny   boy ',
      cache,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(1);
  });

  it('asks again once the memory has gone stale', async () => {
    const cache = freshCache();
    const fetchImpl = vi.fn(async () => jsonResponse(dannyBoy));
    let clock = 1_000;

    const call = () =>
      auditionSearch({
        term: 'danny boy',
        cache,
        ttlMs: 60_000,
        now: () => clock,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

    await call();
    clock += 30_000;
    await call();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    clock += 40_000;
    await call();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('keeps the map small rather than remembering every search forever', async () => {
    const cache = freshCache();
    const fetchImpl = (async () => jsonResponse(dannyBoy)) as unknown as typeof fetch;

    for (const term of ['one', 'two', 'three', 'four']) {
      await auditionSearch({ term, cache, maxEntries: 2, fetchImpl });
    }
    expect(cache.size).toBeLessThanOrEqual(2);
  });

  it('never caches a failure, so a blip does not become a broken screen', async () => {
    const cache = freshCache();
    let attempt = 0;
    const fetchImpl = (async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('connection refused');
      return jsonResponse(dannyBoy);
    }) as unknown as typeof fetch;

    expect(await auditionSearch({ term: 'danny boy', cache, fetchImpl })).toEqual({
      unavailable: true,
    });
    expect(cache.size).toBe(0);

    const second = await auditionSearch({ term: 'danny boy', cache, fetchImpl });
    expect(isAuditionUnavailable(second)).toBe(false);
  });

  it('shrugs when the catalogue refuses, or answers with nonsense', async () => {
    const cache = freshCache();
    const refused = (async () =>
      new Response('go away', { status: 503 })) as unknown as typeof fetch;
    const nonsense = (async () =>
      new Response('<html>oops</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as unknown as typeof fetch;

    expect(await auditionSearch({ term: 'a', cache, fetchImpl: refused })).toEqual({
      unavailable: true,
    });
    expect(await auditionSearch({ term: 'b', cache, fetchImpl: nonsense })).toEqual({
      unavailable: true,
    });
  });

  it('gives up after the timeout instead of leaving somebody waiting', async () => {
    const cache = freshCache();
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;

    const result = await auditionSearch({ term: 'danny boy', cache, timeoutMs: 10, fetchImpl });
    expect(result).toEqual({ unavailable: true });
  });

  it('shares one process-wide memory when no cache is handed in', async () => {
    clearAuditionCache();
    const fetchImpl = vi.fn(async () => jsonResponse(dannyBoy));
    await auditionSearch({ term: 'shared', fetchImpl: fetchImpl as unknown as typeof fetch });
    await auditionSearch({ term: 'shared', fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clearAuditionCache();
  });
});
