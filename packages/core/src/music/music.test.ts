/**
 * The music library, the ordering, and what choosing does to a slideshow.
 *
 * The last of those is the one that matters most: picking a track is not a
 * setting, it re-times the whole video, and a test that only checked a row had
 * been written would pass while the family watched something else.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { EdlSchema, type Edl } from '@col/schemas';
import {
  createTestDb,
  getById,
  insertOne,
  listWhere,
  memorials,
  musicSelections,
  musicTracks,
  slideshowProjects,
  type Db,
  type Memorial,
  type SlideshowProject,
} from '@col/db';
import { loadMusicLibrary } from './library';
import { seedMusicLibrary, bundledTracks, libraryBlobKey } from './seed';
import {
  MOODS,
  describeTrackLength,
  musicGuidanceFor,
  rankTracks,
  traditionMoodBias,
} from './recommend';
import {
  OWNERSHIP_STATEMENT,
  chooseClearedTrack,
  chooseSideloaded,
  currentSelection,
  familyTracks,
  musicChoice,
  recordFamilyTrack,
  summariseMusic,
} from './selection';
import { projectEdl } from '../edl/project';
import { beatGridFromBpm } from '@col/media';

/* -------------------------------------------------------------------------- */
/* the library on disk                                                         */
/* -------------------------------------------------------------------------- */

describe('the bundled library', () => {
  const library = loadMusicLibrary();

  it('has real tracks in it, with audio next to the metadata', () => {
    expect(library.problems).toEqual([]);
    expect(library.tracks.length).toBeGreaterThanOrEqual(4);
    for (const track of library.tracks) {
      expect(track.byteSize).toBeGreaterThan(10_000);
      // Small enough to live in the repository rather than be regenerated.
      expect(track.byteSize).toBeLessThan(3 * 1024 * 1024);
    }
  });

  it('can say where every track came from and under what licence', () => {
    for (const { meta } of library.tracks) {
      expect(meta.licenseKind).not.toBe('family-supplied');
      expect(meta.licenseNote.length).toBeGreaterThan(40);
      expect(meta.licenseNote).toMatch(/CC0|public domain/i);
      expect(meta.verifiedBy).toBeTruthy();
    }
  });

  it('carries an exact beat grid, because the tempo was chosen rather than detected', () => {
    for (const { meta } of library.tracks) {
      const expected = beatGridFromBpm(meta.bpm, meta.durationSec);
      expect(meta.beatGrid.bpm).toBe(expected.bpm);
      expect(meta.beatGrid.beats.length).toBe(expected.beats.length);
      expect(meta.beatGrid.phrases.length).toBe(expected.phrases.length);
      // Phrases every eight beats, so a slide change lands where the music turns.
      const spacing = (meta.beatGrid.phrases[1] ?? 0) - (meta.beatGrid.phrases[0] ?? 0);
      expect(spacing).toBeCloseTo((60 / meta.bpm) * 8, 2);
    }
  });

  it('is a comfortable length for a tribute: two and a half to four minutes', () => {
    for (const { meta } of library.tracks) {
      expect(meta.durationSec).toBeGreaterThan(150);
      expect(meta.durationSec).toBeLessThan(260);
    }
  });

  it('says nothing at all rather than throwing when the directory is missing', () => {
    const empty = loadMusicLibrary('/no/such/library');
    expect(empty.tracks).toEqual([]);
    expect(empty.problems).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* seeding                                                                     */
/* -------------------------------------------------------------------------- */

/** A blob store that only remembers what it was handed. */
function fakeStore() {
  const blobs = new Map<string, number>();
  return {
    blobs,
    put: async (key: string, body: Buffer) => {
      blobs.set(key, body.byteLength);
      return { key, byteSize: body.byteLength };
    },
    exists: async (key: string) => blobs.has(key),
  };
}

describe('seeding the library into the database', () => {
  it('adds every track once and is a no-op the second time', async () => {
    const db = createTestDb();
    const store = fakeStore();

    const first = await seedMusicLibrary(db, store);
    expect(first.added.length).toBeGreaterThanOrEqual(4);
    expect(first.updated).toEqual([]);
    expect(store.blobs.size).toBe(first.added.length);

    const second = await seedMusicLibrary(db, store);
    expect(second.added).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.unchanged.length).toBe(first.added.length);

    // Identity is the slug, so nothing was duplicated and no selection could
    // have been orphaned.
    expect(listWhere(db, musicTracks).length).toBe(first.added.length);
  });

  it('updates a track in place when the library changes, keeping its row id', async () => {
    const db = createTestDb();
    const store = fakeStore();
    await seedMusicLibrary(db, store);

    const before = bundledTracks(db)[0];
    if (!before) throw new Error('nothing seeded');
    db.update(musicTracks).set({ title: 'Something Else' }).run();

    const again = await seedMusicLibrary(db, store);
    expect(again.updated.length).toBeGreaterThan(0);
    const after = getById(db, musicTracks, before.id);
    expect(after?.id).toBe(before.id);
    expect(after?.title).toBe(before.title);
  });

  it('puts bundled audio outside every memorial prefix', () => {
    expect(libraryBlobKey('morning-light')).toBe('library/music/morning-light/audio.m4a');
    expect(libraryBlobKey('morning-light')).not.toContain('memorial/');
  });
});

/* -------------------------------------------------------------------------- */
/* ordering                                                                    */
/* -------------------------------------------------------------------------- */

describe('which track to put first', () => {
  const track = (slug: string, moodTags: string[]) =>
    ({ id: slug, slug, title: slug, moodTags, traditionTags: [] }) as never;

  it('reads restraint out of a tradition that asks for it', () => {
    // Jewish guidance says music is "traditionally minimal or absent"; that is
    // read from the pack's words, never from its slug.
    const bias = traditionMoodBias('jewish');
    expect(bias.peaceful).toBeGreaterThan(0);
    expect(bias.hopeful).toBeLessThan(bias.peaceful);
  });

  it('reads celebration out of a tradition that invites it', () => {
    const bias = traditionMoodBias('secular');
    expect(bias.hopeful).toBeGreaterThan(0);
  });

  it('never throws on a tradition it has never heard of', () => {
    expect(traditionMoodBias('klingon')).toEqual({
      peaceful: 0,
      hopeful: 0,
      reflective: 0,
      warm: 0,
    });
    expect(musicGuidanceFor('klingon')).toEqual([]);
  });

  it('sorts a chosen mood to the top without hiding anything', () => {
    const tracks = [track('a', ['reflective']), track('b', ['hopeful']), track('c', ['warm'])];
    const ranked = rankTracks(tracks, { mood: 'hopeful' });
    expect(ranked[0]?.track.slug).toBe('b');
    // Everything is still there: a list that empties itself is a list a tired
    // person thinks they broke.
    expect(ranked).toHaveLength(3);
  });

  it('breaks ties the same way every time', () => {
    const tracks = [track('z', ['warm']), track('a', ['warm'])];
    expect(rankTracks(tracks).map((r) => r.track.slug)).toEqual(['a', 'z']);
  });

  it('offers every mood a family might mean', () => {
    expect([...MOODS].sort()).toEqual(['hopeful', 'peaceful', 'reflective', 'warm']);
  });

  it('says how long a track is in words', () => {
    expect(describeTrackLength(165)).toBe('2 min 45 sec');
    expect(describeTrackLength(120)).toBe('2 min');
    expect(describeTrackLength(45)).toBe('45 sec');
    expect(describeTrackLength(null)).toBe('');
  });
});

/* -------------------------------------------------------------------------- */
/* choosing                                                                    */
/* -------------------------------------------------------------------------- */

function fixtureEdl(projectId: string): Edl {
  const photo = (id: string) => ({
    kind: 'photo' as const,
    assetId: id,
    variant: 'render2400' as const,
    durationSec: 4.5,
    kenBurns: {
      from: { x: 0, y: 0, w: 1, h: 1 },
      to: { x: 0.05, y: 0.05, w: 0.9, h: 0.9 },
      easing: 'easeInOut' as const,
    },
    transitionOut: { kind: 'crossfade' as const, durationSec: 0.8 },
    suitability: 0.7,
  });

  return EdlSchema.parse({
    version: 1,
    projectId,
    fps: 30,
    resolution: { w: 1920, h: 1080 },
    audio: { mode: 'sideloaded', startOffsetSec: 0 },
    theme: { id: 'quiet-linen' },
    chapters: [
      { id: 'c1', title: 'Early years', slideIds: ['p1', 'p2', 'p3'] },
      { id: 'c2', title: 'Later', slideIds: ['p4', 'p5'] },
    ],
    slides: {
      p1: photo('a1'),
      p2: photo('a2'),
      p3: photo('a3'),
      p4: photo('a4'),
      p5: photo('a5'),
    },
    cuts: { service: { targetSec: 300 } },
    omittedSlideIds: [],
  });
}

describe('choosing music', () => {
  let db: Db;
  let memorial: Memorial;
  let project: SlideshowProject;

  beforeEach(async () => {
    db = createTestDb();
    await seedMusicLibrary(db, fakeStore());
    memorial = insertOne(db, memorials, { decedentName: 'Ruth Kelleher' } as never);
    project = insertOne(db, slideshowProjects, {
      memorialId: memorial.id,
      audioMode: 'sideloaded',
      edl: fixtureEdl('p'),
      edlVersion: 1,
    } as never);
  });

  it('bakes a cleared track into the EDL and re-times the slideshow to it', () => {
    const track = bundledTracks(db)[0];
    if (!track) throw new Error('no tracks');

    const before = projectEdl(getById(db, slideshowProjects, project.id));
    expect(before?.audio.beatGrid).toBeUndefined();

    chooseClearedTrack(db, {
      memorialId: memorial.id,
      projectId: project.id,
      trackId: track.id,
    });

    const after = getById(db, slideshowProjects, project.id);
    const edl = projectEdl(after);
    expect(after?.audioMode).toBe('cleared');
    expect(edl?.audio.mode).toBe('cleared');
    expect(edl?.audio.trackId).toBe(track.id);
    // The grid is on the EDL, which is what the preview and the renderer both
    // read — not only on the selection row.
    expect(edl?.audio.beatGrid?.bpm).toBe(track.bpm);
    expect(after?.edlVersion).toBe(2);

    // At least one slide's hold moved, which is the whole point of snapping.
    const durations = (edl: Edl | undefined) =>
      Object.values(edl?.slides ?? {}).map((slide) => slide.durationSec);
    expect(durations(edl)).not.toEqual(durations(before));
  });

  it('records the choice once, however many times a family changes their mind', () => {
    const tracks = bundledTracks(db);
    const [first, second] = tracks;
    if (!first || !second) throw new Error('need two tracks');

    chooseClearedTrack(db, { memorialId: memorial.id, projectId: project.id, trackId: first.id });
    chooseClearedTrack(db, { memorialId: memorial.id, projectId: project.id, trackId: second.id });

    expect(listWhere(db, musicSelections)).toHaveLength(1);
    expect(currentSelection(db, project.id)?.trackId).toBe(second.id);
  });

  it('keeps the video silent for a song the venue will play', () => {
    chooseSideloaded(db, {
      memorialId: memorial.id,
      projectId: project.id,
      title: 'Danny Boy',
      artist: 'Her brother, on the fiddle',
      bpm: 68,
      beatGrid: beatGridFromBpm(68, 240),
    });

    const after = getById(db, slideshowProjects, project.id);
    const edl = projectEdl(after);
    expect(after?.audioMode).toBe('sideloaded');
    expect(edl?.audio.mode).toBe('sideloaded');
    // No track id: nothing of theirs is stored, which is the entire point.
    expect(edl?.audio.trackId).toBeUndefined();
    expect(edl?.audio.beatGrid?.bpm).toBe(68);

    const selection = currentSelection(db, project.id);
    expect(selection?.sideloadedTitle).toBe('Danny Boy');
    expect(selection?.sideloadedArtist).toBe('Her brother, on the fiddle');
  });

  it('leaves the timing alone when a family does not know the tempo', () => {
    chooseSideloaded(db, { memorialId: memorial.id, projectId: project.id, title: 'Danny Boy' });
    const edl = projectEdl(getById(db, slideshowProjects, project.id));
    expect(edl?.audio.beatGrid).toBeUndefined();
  });

  it('writes down the sentence a family agreed to about their own recording', () => {
    const track = recordFamilyTrack(db, {
      memorialId: memorial.id,
      title: 'Dad at the piano, 1997',
      blobKey: `memorial/${memorial.id}/music/abc.m4a`,
      durationSec: 154,
      bpm: 68,
      beatGrid: beatGridFromBpm(68, 154),
      ownershipStatement: OWNERSHIP_STATEMENT,
    });

    expect(track.licenseKind).toBe('family-supplied');
    expect(track.licenseNote).toContain(OWNERSHIP_STATEMENT);
    expect(track.licenseNote).toMatch(/confirmed by the organiser on \d{4}-\d{2}-\d{2}/);

    // It belongs to this memorial and shows up nowhere else.
    expect(familyTracks(db, memorial.id).map((t) => t.id)).toContain(track.id);
    expect(familyTracks(db, 'some-other-memorial')).toEqual([]);
    // And it is not part of the shared library.
    expect(bundledTracks(db).map((t) => t.id)).not.toContain(track.id);
  });

  it('describes the choice in a sentence a person would say', () => {
    expect(summariseMusic(db, project).decided).toBe(false);
    expect(summariseMusic(db, project).line).toContain('No music chosen');

    const track = bundledTracks(db)[0];
    if (!track) throw new Error('no tracks');
    chooseClearedTrack(db, { memorialId: memorial.id, projectId: project.id, trackId: track.id });
    const cleared = summariseMusic(db, getById(db, slideshowProjects, project.id));
    expect(cleared.decided).toBe(true);
    expect(cleared.line).toContain(track.title);
    expect(cleared.line).toContain('shared anywhere');

    chooseSideloaded(db, { memorialId: memorial.id, projectId: project.id, title: 'Danny Boy' });
    const sideloaded = summariseMusic(db, getById(db, slideshowProjects, project.id));
    expect(sideloaded.line).toContain('silent');
    expect(sideloaded.line).toContain('Danny Boy');
  });

  it('knows nothing has been decided before anything has been decided', () => {
    const choice = musicChoice(db, project);
    expect(choice.decided).toBe(false);
    expect(choice.track).toBeUndefined();
  });

  it('refuses a track that does not exist', () => {
    expect(() =>
      chooseClearedTrack(db, { memorialId: memorial.id, projectId: project.id, trackId: 'nope' }),
    ).toThrow(/no music track/);
  });
});
