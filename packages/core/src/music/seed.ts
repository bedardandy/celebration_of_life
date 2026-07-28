/**
 * Getting the bundled library into the database, idempotently.
 *
 * Runs at worker boot and from `pnpm music:seed`. Two rules:
 *
 *  1. `slug` is the identity. A track's row is updated in place, never
 *     duplicated, because `music_selections.trackId` points at it and a family
 *     who chose "Evensong" last night must still have chosen it this morning.
 *  2. The audio is copied into the blob store, so every read — preview in the
 *     browser, mux in the renderer — goes through one authorised path. A
 *     bundled track and a family's own recording then behave identically
 *     everywhere downstream, which is the only reason the render worker does
 *     not need to know which kind it has.
 */
import { readFile } from 'node:fs/promises';
import {
  eq,
  insertOne,
  listWhere,
  musicTracks,
  updateById,
  type Db,
  type MusicTrack,
} from '@col/db';
import { loadMusicLibrary, type LibraryProblem, type LoadedLibrary } from './library';

/** Where bundled audio lives in the blob store. Not under any memorial. */
export function libraryBlobKey(slug: string, file = 'audio.m4a'): string {
  return `library/music/${slug}/${file}`;
}

/** The subset of a BlobStore this needs. Keeps `@col/core` free of the storage package. */
export type MusicBlobStore = {
  put(key: string, body: Buffer, mime: string): Promise<{ key: string; byteSize: number }>;
  exists(key: string): Promise<boolean>;
};

export type SeedResult = {
  added: string[];
  updated: string[];
  unchanged: string[];
  problems: LibraryProblem[];
};

/**
 * Load `content/music-library` into `music_tracks`.
 *
 * Safe to run on every boot: it compares what is on disk with what is in the
 * database and writes only the differences. A library that cannot be read at
 * all is reported rather than thrown — a music library problem must not stop a
 * family uploading photographs.
 */
export async function seedMusicLibrary(
  db: Db,
  store: MusicBlobStore,
  options: { dir?: string; library?: LoadedLibrary } = {},
): Promise<SeedResult> {
  const library = options.library ?? loadMusicLibrary(options.dir);
  const existing = new Map(
    listWhere(db, musicTracks, undefined, 1000).map((row) => [row.slug, row]),
  );

  const result: SeedResult = { added: [], updated: [], unchanged: [], problems: library.problems };

  for (const track of library.tracks) {
    const { meta } = track;
    const blobKey = libraryBlobKey(meta.slug, meta.audioFile);

    if (!(await store.exists(blobKey))) {
      await store.put(blobKey, await readFile(track.audioPath), meta.mime);
    }

    const values = {
      slug: meta.slug,
      title: meta.title,
      artist: meta.artist ?? null,
      licenseKind: meta.licenseKind,
      licenseNote: meta.licenseNote,
      sourceUrl: meta.sourceUrl ?? null,
      blobKey,
      durationSec: meta.durationSec,
      bpm: meta.bpm,
      beatGrid: meta.beatGrid,
      moodTags: meta.moodTags,
      traditionTags: meta.traditionTags,
    } satisfies Partial<MusicTrack> & { slug: string };

    const row = existing.get(meta.slug);
    if (!row) {
      insertOne(db, musicTracks, values as never);
      result.added.push(meta.slug);
      continue;
    }
    if (isUnchanged(row, values)) {
      result.unchanged.push(meta.slug);
      continue;
    }
    updateById(db, musicTracks, row.id, values as never);
    result.updated.push(meta.slug);
  }

  return result;
}

/** Cheap structural comparison — the beat grid is the only large field. */
function isUnchanged(row: MusicTrack, values: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(values)) {
    const current = (row as unknown as Record<string, unknown>)[key];
    const same =
      typeof value === 'object' && value !== null
        ? JSON.stringify(current) === JSON.stringify(value)
        : current === value;
    if (!same) return false;
  }
  return true;
}

/** Every bundled track, newest library order (by slug), for the picker. */
export function bundledTracks(db: Db): MusicTrack[] {
  return listWhere(db, musicTracks, undefined, 500)
    .filter((track) => track.licenseKind !== 'family-supplied')
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

export function trackBySlug(db: Db, slug: string): MusicTrack | undefined {
  return listWhere(db, musicTracks, eq(musicTracks.slug, slug), 1)[0];
}
