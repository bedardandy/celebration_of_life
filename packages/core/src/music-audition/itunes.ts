/**
 * Finding their song by ear.
 *
 * Somebody knows the song was "the one from the wedding, the slow version" and
 * cannot name it, or names it and picks the wrong recording — there are nine
 * Danny Boys and only one of them sounds like their mother's kitchen. So this
 * exists: a search box, half a minute of each result, and then the name typed
 * into the field the venue's card is printed from.
 *
 * What this is **not**, and the distinction is the whole licensing architecture
 * of this product (see ADR 0002): a preview is never stored, never mixed into
 * the video, and never synced to the timeline. It is a way of *recognising* a
 * song. The song itself is played out loud in the room on the day, by a person,
 * from their own copy — which is exactly why the video can stay silent and
 * therefore shareable.
 *
 * iTunes Search was chosen because it needs no key, no account and no terms
 * acceptance: one GET, JSON back. Everything here is pure but for one fetch,
 * every failure collapses to `{ unavailable: true }`, and no test in this
 * repository ever touches the network.
 */

/* -------------------------------------------------------------------------- */
/* configuration                                                               */
/* -------------------------------------------------------------------------- */

export const ITUNES_SEARCH_ENDPOINT = 'https://itunes.apple.com/search';

/** Eight is a screenful on a phone and a short enough list to read at 1am. */
export const AUDITION_RESULT_LIMIT = 8;

/** A slow answer is the same as no answer to someone typing at a kitchen table. */
export const AUDITION_TIMEOUT_MS = 5_000;

/** Long enough that back-and-forth typing is free; short enough to stay honest. */
export const AUDITION_CACHE_TTL_MS = 5 * 60 * 1000;

/** A ceiling so a long session cannot grow the map without bound. */
export const AUDITION_CACHE_MAX = 64;

/** Longest search term we will send. Anything longer is a paste, not a song. */
export const AUDITION_TERM_MAX = 120;

/* -------------------------------------------------------------------------- */
/* what a result is                                                            */
/* -------------------------------------------------------------------------- */

/**
 * One candidate recording. Deliberately small: enough to recognise a version by
 * (who, which album, what it sounds like) and nothing that could be mistaken
 * for something we hold on to.
 */
export type AuditionTrack = {
  /** Apple's track id, or the preview URL when a row somehow has no id. */
  id: string;
  trackName: string;
  artistName: string;
  collectionName?: string;
  /** Thirty seconds, served by Apple. Never downloaded, never stored. */
  previewUrl: string;
  artworkUrl100?: string;
  durationMs?: number;
  /**
   * Passed through, never filtered on. Their song is their song, and a product
   * that quietly hid a parent's favourite record would be making a judgement it
   * has no business making.
   */
  explicit: boolean;
};

export type AuditionResults = { tracks: AuditionTrack[] };
export type AuditionUnavailable = { unavailable: true };

/**
 * Either some songs or an honest shrug. There is no error case on purpose: the
 * screen degrades to typing the name, which was always allowed anyway.
 */
export type AuditionResult = AuditionResults | AuditionUnavailable;

export function isAuditionUnavailable(result: AuditionResult): result is AuditionUnavailable {
  return 'unavailable' in result;
}

/* -------------------------------------------------------------------------- */
/* the request                                                                 */
/* -------------------------------------------------------------------------- */

export type SearchUrlOptions = {
  endpoint?: string;
  limit?: number;
  /** iTunes storefront. Only affects which catalogue rows come back. */
  country?: string;
};

/**
 * Collapse whitespace and cap the length, so "  danny   boy " and "danny boy"
 * are one query and one cache entry rather than two.
 */
export function normaliseTerm(term: string): string {
  return term.replace(/\s+/g, ' ').trim().slice(0, AUDITION_TERM_MAX);
}

/** The one URL this module ever asks for. */
export function buildItunesSearchUrl(term: string, options: SearchUrlOptions = {}): string {
  const url = new URL(options.endpoint ?? ITUNES_SEARCH_ENDPOINT);
  url.searchParams.set('media', 'music');
  url.searchParams.set('entity', 'song');
  url.searchParams.set('limit', String(options.limit ?? AUDITION_RESULT_LIMIT));
  url.searchParams.set('term', normaliseTerm(term));
  if (options.country) url.searchParams.set('country', options.country);
  return url.toString();
}

/* -------------------------------------------------------------------------- */
/* the response                                                                */
/* -------------------------------------------------------------------------- */

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Apple's rows, narrowed to the six things a person needs to recognise a
 * recording — and only the rows that can actually be listened to.
 *
 * A row with no `previewUrl` is dropped rather than shown greyed out: a card
 * with a disabled Listen button is a small cruelty on a screen whose entire
 * promise is "listen and be sure".
 */
export function mapItunesResponse(payload: unknown): AuditionTrack[] {
  const rows = (payload as { results?: unknown })?.results;
  if (!Array.isArray(rows)) return [];

  const tracks: AuditionTrack[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const record = row as Record<string, unknown>;

    const previewUrl = text(record['previewUrl']);
    const trackName = text(record['trackName']) ?? text(record['trackCensoredName']);
    const artistName = text(record['artistName']);
    if (!previewUrl || !trackName || !artistName) continue;

    const trackId = record['trackId'];
    const id =
      typeof trackId === 'number' || typeof trackId === 'string' ? String(trackId) : previewUrl;
    if (seen.has(id)) continue;
    seen.add(id);

    const collectionName = text(record['collectionName']);
    const artworkUrl100 = text(record['artworkUrl100']);
    const millis = record['trackTimeMillis'];

    tracks.push({
      id,
      trackName,
      artistName,
      ...(collectionName ? { collectionName } : {}),
      previewUrl,
      ...(artworkUrl100 ? { artworkUrl100 } : {}),
      ...(typeof millis === 'number' && Number.isFinite(millis) && millis > 0
        ? { durationMs: Math.round(millis) }
        : {}),
      explicit: record['trackExplicitness'] === 'explicit',
    });
  }

  return tracks;
}

/* -------------------------------------------------------------------------- */
/* the cache                                                                   */
/* -------------------------------------------------------------------------- */

type CacheEntry = { expiresAt: number; tracks: AuditionTrack[] };

/**
 * A Map, on purpose.
 *
 * Somebody typing "danny boy" one letter at a time, then deleting a word and
 * putting it back, should not send that many requests to Apple. Five minutes of
 * memory in one process is the whole requirement; a cache dependency for this
 * would be a dependency to keep current for the life of the product.
 *
 * Only successes are cached. A failure that stuck for five minutes would turn a
 * two-second network blip into a screen that stays broken.
 */
export type AuditionCache = Map<string, CacheEntry>;

const defaultCache: AuditionCache = new Map();

export function clearAuditionCache(cache: AuditionCache = defaultCache): void {
  cache.clear();
}

/** Exposed for tests; nothing else should need to look inside. */
export function auditionCacheSize(cache: AuditionCache = defaultCache): number {
  return cache.size;
}

function cacheKey(term: string, country?: string): string {
  return `${country ?? ''} ${normaliseTerm(term).toLowerCase()}`;
}

/* -------------------------------------------------------------------------- */
/* the search                                                                  */
/* -------------------------------------------------------------------------- */

export type AuditionSearchOptions = SearchUrlOptions & {
  term: string;
  /** Injectable for tests. Nothing in this repo's tests ever touches the network. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  cache?: AuditionCache;
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
};

/**
 * Search, with a stopwatch and a short memory.
 *
 * Every way this can go wrong — a refused connection, a 500, HTML where JSON
 * should be, five seconds of silence — comes back as `{ unavailable: true }`,
 * because on this screen there is nothing a person could usefully do with the
 * difference and there is always the option of typing the name.
 */
export async function auditionSearch(options: AuditionSearchOptions): Promise<AuditionResult> {
  const term = normaliseTerm(options.term);
  // An empty box is not a failure; it is a person who has not typed yet.
  if (term.length === 0) return { tracks: [] };

  const cache = options.cache ?? defaultCache;
  const now = options.now ?? Date.now;
  const key = cacheKey(term, options.country);

  const hit = cache.get(key);
  if (hit) {
    if (hit.expiresAt > now()) return { tracks: hit.tracks };
    cache.delete(key);
  }

  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? AUDITION_TIMEOUT_MS);

  try {
    const response = await doFetch(buildItunesSearchUrl(term, options), {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return { unavailable: true };

    // iTunes serves JSON with a javascript content type, so this is parsed
    // rather than trusted: `response.json()` is fine, the type header is not.
    const tracks = mapItunesResponse(await response.json());

    // Oldest out first. Insertion order is Map's own, so there is no bookkeeping.
    const max = options.maxEntries ?? AUDITION_CACHE_MAX;
    while (cache.size >= max) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
    cache.set(key, { expiresAt: now() + (options.ttlMs ?? AUDITION_CACHE_TTL_MS), tracks });

    return { tracks };
  } catch {
    // Aborted, refused, or nonsense in the body. All the same to this screen.
    return { unavailable: true };
  } finally {
    clearTimeout(timer);
  }
}
