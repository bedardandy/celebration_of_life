/**
 * The part of the audition that can be reasoned about without a browser.
 *
 * Two rules carry the whole screen and both are easy to get wrong in a
 * component: nothing plays unless somebody pressed a button, and only ever one
 * thing plays at a time. A family opening this page in a quiet house at
 * midnight must not have music start at them, and pressing Listen on a second
 * song must silence the first rather than layer it.
 *
 * So the rules live here, as a reducer over plain values, and the component is
 * left with the job of pointing one `<audio>` element at whatever this says.
 */
import type { AuditionTrack } from '@col/core/music-audition';

/** What the search box is currently doing. Never an "error" — see `unavailable`. */
export type AuditionStatus = 'idle' | 'searching' | 'results' | 'nothing' | 'unavailable';

export type AuditionState = {
  status: AuditionStatus;
  tracks: AuditionTrack[];
  /** The one track making sound, if any. Null is silence, and is the default. */
  playingId: string | null;
};

export const initialAuditionState: AuditionState = {
  status: 'idle',
  tracks: [],
  playingId: null,
};

export type AuditionEvent =
  | { type: 'search-started' }
  | { type: 'search-answered'; tracks: AuditionTrack[] }
  | { type: 'search-unavailable' }
  | { type: 'play'; id: string }
  | { type: 'pause' }
  | { type: 'ended' }
  /** The preview URL would not play. Quietly stop; do not shout about it. */
  | { type: 'audio-problem' };

/**
 * Every transition, in one place.
 *
 * Note what a new search does to playback: it stops it. Results changing under
 * a song that is still playing is the sort of small confusion that makes a
 * person distrust a screen, and this is not a screen anybody can afford to
 * distrust.
 */
export function auditionReducer(state: AuditionState, event: AuditionEvent): AuditionState {
  switch (event.type) {
    case 'search-started':
      return { ...state, status: 'searching', playingId: null };

    case 'search-answered':
      return {
        status: event.tracks.length > 0 ? 'results' : 'nothing',
        tracks: event.tracks,
        playingId: null,
      };

    case 'search-unavailable':
      // The words the person reads change; what they can do does not. The
      // manual fields were always there and remain the way through.
      return { status: 'unavailable', tracks: [], playingId: null };

    case 'play':
      // Pressing Listen on the song already playing is a pause, which is what
      // the button says at that moment.
      return {
        ...state,
        playingId: state.playingId === event.id ? null : event.id,
      };

    case 'pause':
    case 'ended':
    case 'audio-problem':
      return { ...state, playingId: null };

    default:
      return state;
  }
}

/** The URL the single shared `<audio>` element should be pointing at. */
export function currentPreviewUrl(state: AuditionState): string | undefined {
  return state.tracks.find((track) => track.id === state.playingId)?.previewUrl;
}

/* -------------------------------------------------------------------------- */
/* choosing one                                                                */
/* -------------------------------------------------------------------------- */

/** Anything with a `value`: a real `<input>` in the browser, a plain object in tests. */
export type FieldLike = { value: string };

/**
 * "This is the one" — the only thing an audition leaves behind.
 *
 * It writes two strings into the fields the organiser could have typed
 * themselves, and that is the entire persistence story for this feature. The
 * preview is not downloaded, not attached to the video, and not remembered.
 * The artist is only filled in when we have one, because an empty artist field
 * already means something here ("whose version, if it matters").
 */
export function applyAuditionChoice(
  track: Pick<AuditionTrack, 'trackName' | 'artistName'>,
  fields: { title?: FieldLike | null; artist?: FieldLike | null },
): void {
  if (fields.title) fields.title.value = track.trackName;
  if (fields.artist && track.artistName) fields.artist.value = track.artistName;
}

/** "3:58" — how long the real song runs, not how long the preview does. */
export function formatTrackLength(durationMs?: number): string | undefined {
  if (!durationMs || !Number.isFinite(durationMs) || durationMs <= 0) return undefined;
  const total = Math.round(durationMs / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
