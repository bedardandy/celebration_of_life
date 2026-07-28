/**
 * Choosing the music, and what that changes.
 *
 * A music choice is not a setting. Picking a track re-times the whole
 * slideshow: the timing engine snaps slide changes to that track's phrase
 * boundaries, so the moment a family taps "use this one" the video they are
 * about to watch is a different video. This module is where that happens, in
 * one place, for all three ways music can arrive:
 *
 *   cleared      a bundled track, baked into the file — shareable anywhere
 *   family       the family's own recording, baked in on their word that it is
 *                theirs to use
 *   sideloaded   the video stays silent, timed to a song the venue will play
 *
 * The last one is the reason this product can honour "her favourite song" at
 * all: nothing is embedded, so nothing is licensed, and the room still hears it.
 */
import type { AudioMode, BeatGrid, Edl } from '@col/schemas';
import {
  desc,
  eq,
  getById,
  insertOne,
  listWhere,
  musicSelections,
  musicTracks,
  slideshowProjects,
  updateById,
  type Db,
  type MusicSelection,
  type MusicTrack,
  type SlideshowProject,
} from '@col/db';
import { projectEdl, saveEdl } from '../edl/project';
import { withFittedDurations } from '../edl/timing';

/* -------------------------------------------------------------------------- */
/* reading the current choice                                                  */
/* -------------------------------------------------------------------------- */

export function currentSelection(db: Db, projectId: string): MusicSelection | undefined {
  return db
    .select()
    .from(musicSelections)
    .where(eq(musicSelections.projectId, projectId))
    .orderBy(desc(musicSelections.createdAt))
    .limit(1)
    .all()[0];
}

export type MusicChoice = {
  mode: AudioMode;
  selection?: MusicSelection;
  track?: MusicTrack;
  /** True once the family has actually decided something. */
  decided: boolean;
};

export function musicChoice(db: Db, project: SlideshowProject | undefined): MusicChoice {
  if (!project) return { mode: 'cleared', decided: false };
  const selection = currentSelection(db, project.id);
  if (!selection) return { mode: project.audioMode, decided: false };
  const track = selection.trackId ? getById(db, musicTracks, selection.trackId) : undefined;
  return {
    mode: selection.mode,
    selection,
    ...(track ? { track } : {}),
    decided: true,
  };
}

/** A family's own uploads live alongside the bundled library, scoped to them. */
export function familyTracks(db: Db, memorialId: string): MusicTrack[] {
  return listWhere(db, musicTracks, eq(musicTracks.licenseKind, 'family-supplied'), 200).filter(
    (track) => track.blobKey?.startsWith(`memorial/${memorialId}/`),
  );
}

/* -------------------------------------------------------------------------- */
/* making a choice                                                             */
/* -------------------------------------------------------------------------- */

export type ClearedChoice = {
  memorialId: string;
  projectId: string;
  trackId: string;
  startOffsetSec?: number;
};

/**
 * Bake a cleared track in.
 *
 * The beat grid goes onto the EDL, not just onto the selection row, because the
 * EDL is what both the browser preview and the renderer read. Re-fitting the
 * durations at the same time is what makes "the cuts snap to the music"
 * something a family can see on the preview screen a second later rather than a
 * claim that only comes true at render time.
 */
export function chooseClearedTrack(db: Db, choice: ClearedChoice): MusicSelection {
  const track = getById(db, musicTracks, choice.trackId);
  if (!track) throw new Error(`no music track ${choice.trackId}`);

  const selection = replaceSelection(db, {
    memorialId: choice.memorialId,
    projectId: choice.projectId,
    trackId: track.id,
    mode: 'cleared',
    startOffsetSec: choice.startOffsetSec ?? 0,
  });

  updateById(db, slideshowProjects, choice.projectId, { audioMode: 'cleared' });
  applyAudioToProject(db, choice.projectId, {
    mode: 'cleared',
    trackId: track.id,
    startOffsetSec: choice.startOffsetSec ?? 0,
    ...(track.beatGrid ? { beatGrid: track.beatGrid } : {}),
  });

  return selection;
}

export type SideloadedChoice = {
  memorialId: string;
  projectId: string;
  title: string;
  artist?: string;
  /** Tapped or typed. Optional: a family may simply not know. */
  bpm?: number;
  /** The grid built from that BPM, for snapping the cuts. */
  beatGrid?: BeatGrid;
};

/**
 * Keep the video silent and time it to their song.
 *
 * No audio is stored, uploaded or analysed — we never see the recording. The
 * title and artist exist so the venue timing card can name what someone has to
 * press play on, and the beat grid, if we have one, only shapes where the
 * slides change.
 */
export function chooseSideloaded(db: Db, choice: SideloadedChoice): MusicSelection {
  const selection = replaceSelection(db, {
    memorialId: choice.memorialId,
    projectId: choice.projectId,
    trackId: null,
    mode: 'sideloaded',
    sideloadedTitle: choice.title.trim() || null,
    sideloadedArtist: choice.artist?.trim() || null,
    startOffsetSec: 0,
  });

  updateById(db, slideshowProjects, choice.projectId, { audioMode: 'sideloaded' });
  applyAudioToProject(db, choice.projectId, {
    mode: 'sideloaded',
    startOffsetSec: 0,
    ...(choice.beatGrid ? { beatGrid: choice.beatGrid } : {}),
  });

  return selection;
}

/**
 * One selection per project, replaced rather than accumulated.
 *
 * A family changing their mind four times should leave one row saying what they
 * chose, not four rows and a question about which one counts.
 */
function replaceSelection(
  db: Db,
  values: {
    memorialId: string;
    projectId: string;
    trackId: string | null;
    mode: AudioMode;
    sideloadedTitle?: string | null;
    sideloadedArtist?: string | null;
    startOffsetSec: number;
  },
): MusicSelection {
  const existing = currentSelection(db, values.projectId);
  if (existing) {
    const updated = updateById(db, musicSelections, existing.id, {
      trackId: values.trackId,
      mode: values.mode,
      sideloadedTitle: values.sideloadedTitle ?? null,
      sideloadedArtist: values.sideloadedArtist ?? null,
      startOffsetSec: values.startOffsetSec,
    });
    if (updated) return updated;
  }
  return insertOne(db, musicSelections, values as never);
}

export type EdlAudioPatch = {
  mode: AudioMode;
  trackId?: string;
  startOffsetSec: number;
  beatGrid?: BeatGrid;
};

/**
 * Write the audio section onto the EDL and re-fit the timings.
 *
 * `withFittedDurations` re-runs the family cut with the new grid and bakes the
 * answers back onto the slides, so what the preview screen shows and what the
 * renderer produces are the same arithmetic — done once, here, rather than
 * twice, later, on two machines.
 */
export function applyAudioToProject(
  db: Db,
  projectId: string,
  audio: EdlAudioPatch,
): Edl | undefined {
  const project = getById(db, slideshowProjects, projectId);
  const edl = projectEdl(project);
  if (!edl) return undefined;

  const next: Edl = withFittedDurations({
    ...edl,
    audio: {
      mode: audio.mode,
      startOffsetSec: audio.startOffsetSec,
      ...(audio.trackId ? { trackId: audio.trackId } : {}),
      ...(audio.beatGrid ? { beatGrid: audio.beatGrid } : {}),
    },
  });

  saveEdl(db, projectId, next);
  return next;
}

/* -------------------------------------------------------------------------- */
/* family-supplied audio                                                       */
/* -------------------------------------------------------------------------- */

export type FamilyTrackInput = {
  memorialId: string;
  title: string;
  artist?: string;
  blobKey: string;
  durationSec: number;
  bpm: number;
  beatGrid: BeatGrid;
  /** What the family actually ticked, recorded in their words, not ours. */
  ownershipStatement: string;
};

/**
 * Record a recording the family says is theirs.
 *
 * The licence note stores the sentence they confirmed, verbatim and dated. If
 * anyone ever asks why this audio is in a video, the answer is a thing a named
 * person agreed to on a date, not an assumption the software made.
 */
export function recordFamilyTrack(db: Db, input: FamilyTrackInput): MusicTrack {
  const slug = `family-${input.memorialId}-${Date.now().toString(36)}`;
  return insertOne(db, musicTracks, {
    slug,
    title: input.title.trim() || 'A recording of our own',
    artist: input.artist?.trim() || null,
    licenseKind: 'family-supplied',
    licenseNote: `${input.ownershipStatement} — confirmed by the organiser on ${new Date()
      .toISOString()
      .slice(0, 10)}.`,
    blobKey: input.blobKey,
    durationSec: input.durationSec,
    bpm: input.bpm,
    beatGrid: input.beatGrid,
    moodTags: [],
    traditionTags: [],
  } as never);
}

/** The one sentence a family has to agree with before their own audio is used. */
export const OWNERSHIP_STATEMENT = 'This recording belongs to our family, or is ours to use.';

/* -------------------------------------------------------------------------- */
/* what the music screens need to know                                         */
/* -------------------------------------------------------------------------- */

export type MusicSummary = {
  mode: AudioMode;
  decided: boolean;
  /** One line for the dashboard and the deliver page. */
  line: string;
  trackTitle?: string;
};

export function summariseMusic(db: Db, project: SlideshowProject | undefined): MusicSummary {
  const choice = musicChoice(db, project);
  if (!choice.decided) {
    return { mode: choice.mode, decided: false, line: 'No music chosen yet.' };
  }
  if (choice.mode === 'cleared') {
    const title = choice.track?.title ?? 'a track from the library';
    return {
      mode: 'cleared',
      decided: true,
      line: `${title} is included in the video, so it can be shared anywhere.`,
      ...(choice.track?.title ? { trackTitle: choice.track.title } : {}),
    };
  }
  const song = [choice.selection?.sideloadedTitle, choice.selection?.sideloadedArtist]
    .filter(Boolean)
    .join(' — ');
  return {
    mode: 'sideloaded',
    decided: true,
    line: song
      ? `The video is silent and timed to ${song}, which the venue plays.`
      : 'The video is silent, and the venue plays the song.',
    ...(choice.selection?.sideloadedTitle ? { trackTitle: choice.selection.sideloadedTitle } : {}),
  };
}
