/**
 * Reading the bundled music library off disk.
 *
 * `content/music-library/<slug>/meta.json` is the source of truth for what a
 * track is and, more importantly, for why we are allowed to put it in a video a
 * family will publish. A track whose metadata does not parse is excluded rather
 * than shipped half-known — the one thing worse than having no music is having
 * music we cannot describe the licence of.
 *
 * Nothing here touches the database. Seeding is a separate step so that reading
 * the library can be tested, and so a broken track fails at seed time with a
 * name attached rather than at 11pm in front of somebody choosing music for
 * their mother's funeral.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { MusicTrackMetaSchema, type MusicTrackMeta } from '@col/schemas';
import { workspaceRoot } from '@col/db';

export const MUSIC_LIBRARY_DIR = path.join(workspaceRoot(), 'content', 'music-library');

export type LibraryTrack = {
  meta: MusicTrackMeta;
  /** Absolute path to the audio file. */
  audioPath: string;
  byteSize: number;
};

export type LibraryProblem = {
  slug: string;
  reason: string;
};

export type LoadedLibrary = {
  tracks: LibraryTrack[];
  /** Directories that looked like tracks but could not be used, and why. */
  problems: LibraryProblem[];
};

/**
 * Every usable track, in a stable order.
 *
 * Ordered by slug rather than by mtime or directory order so that two machines
 * seeding the same library produce the same rows — the picker's default order
 * is a product decision, not a filesystem accident.
 */
export function loadMusicLibrary(dir: string = MUSIC_LIBRARY_DIR): LoadedLibrary {
  const tracks: LibraryTrack[] = [];
  const problems: LibraryProblem[] = [];

  if (!existsSync(dir)) return { tracks, problems };

  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const slug of entries) {
    const metaFile = path.join(dir, slug, 'meta.json');
    if (!existsSync(metaFile)) {
      problems.push({ slug, reason: 'has no meta.json' });
      continue;
    }

    let parsed: MusicTrackMeta;
    try {
      const result = MusicTrackMetaSchema.safeParse(JSON.parse(readFileSync(metaFile, 'utf8')));
      if (!result.success) {
        problems.push({
          slug,
          reason: `meta.json failed validation: ${result.error.issues
            .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
            .join('; ')}`,
        });
        continue;
      }
      parsed = result.data;
    } catch (error) {
      problems.push({ slug, reason: `meta.json is not valid JSON (${String(error)})` });
      continue;
    }

    if (parsed.slug !== slug) {
      problems.push({ slug, reason: `declares slug "${parsed.slug}"; must match its directory` });
      continue;
    }
    if (parsed.licenseKind === 'family-supplied') {
      // A family's own recording belongs to their memorial, never to the shared
      // library — if one ever appears here it is a bug worth surfacing.
      problems.push({ slug, reason: 'is marked family-supplied and cannot be a bundled track' });
      continue;
    }

    const audioPath = path.join(dir, slug, parsed.audioFile);
    if (!existsSync(audioPath)) {
      problems.push({
        slug,
        reason: `${parsed.audioFile} is missing — run \`pnpm music:build\` to regenerate it`,
      });
      continue;
    }

    tracks.push({ meta: parsed, audioPath, byteSize: statSync(audioPath).size });
  }

  return { tracks, problems };
}
