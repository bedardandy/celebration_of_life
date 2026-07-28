/**
 * Which track to put first.
 *
 * A family choosing music for a funeral is not browsing. They will listen to
 * two or three things and pick one, so the order the picker uses is very nearly
 * the decision. Two inputs decide it:
 *
 *  - the tradition pack's own `musicGuidance`, in the pack's words. Read for a
 *    handful of unmistakable signals ("hymn", "sacred", "minimal or absent")
 *    rather than parsed: the guidance is written for humans and is shown to the
 *    family verbatim, and this only nudges an ordering.
 *  - the mood the family asked for, if they asked for one.
 *
 * There is no `if (tradition === 'catholic')` here, and there must never be.
 * Every signal comes from the pack's text, so a new pack changes the ordering
 * by being written, not by being coded for.
 */
import { getPack } from '@col/tradition-packs';
import type { MoodTag } from '@col/schemas';
import type { MusicTrack } from '@col/db';

export const MOODS: readonly MoodTag[] = ['peaceful', 'hopeful', 'reflective', 'warm'];

export const MOOD_LABELS: Record<MoodTag, string> = {
  peaceful: 'Calm and still',
  hopeful: 'Lifting',
  reflective: 'Thoughtful',
  warm: 'Warm',
};

/** Words in a pack's guidance that point at a mood, and how strongly. */
const SIGNALS: { pattern: RegExp; weights: Partial<Record<MoodTag, number>> }[] = [
  // Restraint: quiet houses, minimal music, "take your lead from the rabbi".
  {
    pattern: /minimal|absent|quiet|restrain|solemn|silence|subdued/i,
    weights: { peaceful: 2, reflective: 1.5, hopeful: -1 },
  },
  // Liturgical settings: hymn-shaped material sits best.
  {
    pattern: /hymn|sacred|liturg|psalm|chant|prayer/i,
    weights: { peaceful: 1.5, warm: 1, reflective: 0.5 },
  },
  // Celebration: a life being enjoyed out loud.
  {
    pattern: /celebrat|joyful|upbeat|favourite songs|favorite songs|dance/i,
    weights: { hopeful: 1.5, warm: 1 },
  },
  { pattern: /gentle instrumental|instrumental/i, weights: { peaceful: 1, reflective: 1 } },
];

export type MoodBias = Record<MoodTag, number>;

/**
 * Read a tradition's guidance for mood signals.
 *
 * Deliberately blunt. The output is a nudge to an ordering, and being wrong
 * costs a family one extra scroll — which is the right amount of risk to take
 * in exchange for never branching on somebody's religion.
 */
export function traditionMoodBias(traditionSlug: string): MoodBias {
  const bias: MoodBias = { peaceful: 0, hopeful: 0, reflective: 0, warm: 0 };
  let guidance: string;
  try {
    guidance = getPack(traditionSlug).musicGuidance.join(' \n ');
  } catch {
    return bias;
  }
  for (const signal of SIGNALS) {
    if (!signal.pattern.test(guidance)) continue;
    for (const [mood, weight] of Object.entries(signal.weights)) {
      bias[mood as MoodTag] += weight as number;
    }
  }
  return bias;
}

/** The guidance itself, for showing on the screen. Never paraphrased. */
export function musicGuidanceFor(traditionSlug: string): string[] {
  try {
    return getPack(traditionSlug).musicGuidance;
  } catch {
    return [];
  }
}

export type RankOptions = {
  traditionSlug?: string;
  /** A mood the family picked. Filters rather than nudges. */
  mood?: MoodTag;
};

export type RankedTrack = {
  track: MusicTrack;
  score: number;
  /** Why it is where it is, in words. Shown only on the top card. */
  why?: string;
};

/**
 * Rank, never hide.
 *
 * When a family picks a mood, tracks outside it drop to the bottom rather than
 * disappearing: a list that empties itself when someone taps a filter is a list
 * that makes a tired person think they have broken something.
 */
export function rankTracks(
  tracks: readonly MusicTrack[],
  options: RankOptions = {},
): RankedTrack[] {
  const bias = options.traditionSlug ? traditionMoodBias(options.traditionSlug) : undefined;

  return tracks
    .map((track) => {
      const moods = (track.moodTags ?? []) as MoodTag[];
      let score = 0;

      if (bias) {
        for (const mood of moods) score += bias[mood] ?? 0;
        // A track can carry two moods; average rather than reward breadth.
        if (moods.length > 1) score /= moods.length;
      }
      if (options.mood) score += moods.includes(options.mood) ? 10 : -10;
      if ((track.traditionTags ?? []).includes(options.traditionSlug ?? '')) score += 3;

      const why = topReason(moods, options, bias);
      return { track, score, ...(why ? { why } : {}) };
    })
    .sort((a, b) => b.score - a.score || (a.track.slug < b.track.slug ? -1 : 1));
}

function topReason(
  moods: readonly MoodTag[],
  options: RankOptions,
  bias: MoodBias | undefined,
): string | undefined {
  if (options.mood && moods.includes(options.mood)) {
    return `${MOOD_LABELS[options.mood].toLowerCase()}, which is what you asked for`;
  }
  if (!bias) return undefined;
  const strongest = MOODS.filter((mood) => moods.includes(mood) && (bias[mood] ?? 0) > 0).sort(
    (a, b) => (bias[b] ?? 0) - (bias[a] ?? 0),
  )[0];
  return strongest ? `often chosen for services like this one` : undefined;
}

/** "2 min 45 sec" — how long a track runs, for the card. */
export function describeTrackLength(durationSec: number | null | undefined): string {
  const seconds = Math.round(durationSec ?? 0);
  if (seconds <= 0) return '';
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) return `${rest} sec`;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest < 10 ? '0' : ''}${rest} sec`;
}
