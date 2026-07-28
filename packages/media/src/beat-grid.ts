/**
 * Beat grids, from a number rather than from a signal.
 *
 * There are three ways a tempo reaches this product and only one of them
 * involves listening to anything:
 *
 *  1. A bundled track was *synthesised* at a known BPM, so its grid is exact
 *     arithmetic — no detection, no drift, no confidence interval.
 *  2. A family uploaded a recording of their own, so `detectTempo` estimates it
 *     and this file turns the estimate into a grid.
 *  3. A family is having the venue play a song we never see, and taps along to
 *     it eight times — `tapTempoBpm` turns those taps into a number.
 *
 * All three end up in the same place: `phrases`, every eight beats, which is
 * what the timing engine actually snaps slide changes to. Beats alone make a
 * slideshow look frantic; phrase boundaries are what make it feel composed.
 */
import type { BeatGrid } from '@col/schemas';

/** Four bars of 4/4. The unit a listener hears as "a line of the music". */
export const BEATS_PER_PHRASE = 8;

/** Below and above this, a "tempo" is a mis-tap or a mis-detection. */
export const MIN_BPM = 30;
export const MAX_BPM = 240;

export type BeatGridOptions = {
  /** Seconds before the first beat — a track that does not start on one. */
  offsetSec?: number;
  beatsPerPhrase?: number;
};

export function isPlausibleBpm(bpm: number): boolean {
  return Number.isFinite(bpm) && bpm >= MIN_BPM && bpm <= MAX_BPM;
}

/**
 * Fold a tempo into the range a memorial slideshow can use.
 *
 * A detector that reports 152 for a slow hymn has almost certainly counted the
 * off-beats; halving it is nearly always right, and doubling a 38 likewise. The
 * band is deliberately wide — this fixes octave errors, it does not impose
 * taste.
 */
export function foldBpm(bpm: number, min = 55, max = 110): number {
  if (!Number.isFinite(bpm) || bpm <= 0) return bpm;
  let out = bpm;
  for (let i = 0; i < 4 && out > max; i += 1) out /= 2;
  for (let i = 0; i < 4 && out < min; i += 1) out *= 2;
  return out;
}

/**
 * Every beat and every phrase boundary in a track of this length.
 *
 * Rounded to the millisecond so the same track produces byte-identical JSON on
 * every machine — a grid that wobbled in the sixteenth decimal place would make
 * two renders of the same slideshow differ by a frame.
 */
export function beatGridFromBpm(
  bpm: number,
  durationSec: number,
  options: BeatGridOptions = {},
): BeatGrid {
  if (!isPlausibleBpm(bpm)) throw new RangeError(`implausible bpm: ${bpm}`);
  if (!(durationSec > 0)) throw new RangeError(`duration must be positive: ${durationSec}`);

  const offset = Math.max(0, options.offsetSec ?? 0);
  const perPhrase = Math.max(1, Math.round(options.beatsPerPhrase ?? BEATS_PER_PHRASE));
  const secondsPerBeat = 60 / bpm;

  const beats: number[] = [];
  const phrases: number[] = [];
  for (let index = 0; ; index += 1) {
    const at = offset + index * secondsPerBeat;
    if (at > durationSec) break;
    const rounded = Math.round(at * 1000) / 1000;
    beats.push(rounded);
    if (index % perPhrase === 0) phrases.push(rounded);
  }
  return { bpm: Math.round(bpm * 1000) / 1000, beats, phrases };
}

/**
 * A grid for a song we will never hold: sideloaded mode.
 *
 * The family taps a tempo and tells us roughly how long the song is; the
 * slideshow is then cut to phrases that will line up with what the venue plays,
 * without a single second of that recording ever touching this machine.
 */
export function guidanceGrid(bpm: number, durationSec: number): BeatGrid {
  return beatGridFromBpm(foldBpm(bpm), durationSec);
}

export type TapTempoResult = {
  bpm: number;
  /** Taps that actually contributed, after outliers were discarded. */
  usedTaps: number;
  /**
   * 0..1. How consistent the taps were — the UI says "that looks steady" or
   * "try once more" rather than showing a number nobody asked for.
   */
  confidence: number;
};

/**
 * Turn tap times into a tempo, forgiving one unsteady tap.
 *
 * The median interval rather than the mean, because a single distracted pause
 * in eight taps should not move the answer, and someone doing this at midnight
 * on their phone will pause. Intervals more than 40% away from the median are
 * dropped before the average is taken, which is what makes "I tapped, sneezed,
 * tapped again" still give the right number.
 */
export function tapTempoBpm(timestampsMs: readonly number[]): TapTempoResult | undefined {
  const taps = [...timestampsMs].filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  if (taps.length < 3) return undefined;

  const intervals: number[] = [];
  for (let i = 1; i < taps.length; i += 1) {
    const gap = (taps[i] as number) - (taps[i - 1] as number);
    if (gap > 0) intervals.push(gap);
  }
  if (intervals.length < 2) return undefined;

  const median = medianOf(intervals);
  if (!(median > 0)) return undefined;

  const kept = intervals.filter((gap) => Math.abs(gap - median) <= median * 0.4);
  const use = kept.length >= 2 ? kept : intervals;
  const mean = use.reduce((a, b) => a + b, 0) / use.length;
  const bpm = 60_000 / mean;
  if (!isPlausibleBpm(bpm)) return undefined;

  // Spread relative to the beat: a quarter of a beat of jitter reads as zero
  // confidence, dead-steady tapping reads as one.
  const spread = use.reduce((sum, gap) => sum + Math.abs(gap - mean), 0) / use.length;
  const confidence = Math.max(0, Math.min(1, 1 - spread / (mean * 0.25)));

  return {
    bpm: Math.round(bpm * 10) / 10,
    usedTaps: use.length + 1,
    confidence: Math.round(confidence * 100) / 100,
  };
}

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return (((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2) as number;
}

/** "About 72 beats a minute — a slow, walking pace." */
export function describeTempo(bpm: number): string {
  const rounded = Math.round(bpm);
  if (rounded < 66) return `about ${rounded} beats a minute — very slow and still`;
  if (rounded < 80) return `about ${rounded} beats a minute — a slow, walking pace`;
  if (rounded < 100) return `about ${rounded} beats a minute — gently moving`;
  return `about ${rounded} beats a minute — brisker than most tribute music`;
}
