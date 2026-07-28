/**
 * The arithmetic that puts slide changes on the music.
 *
 * All of it is a pure function of a tempo, which is the point: a bundled track
 * is synthesised at a BPM we chose, so its grid is exact rather than detected,
 * and the same grid comes out on every machine forever.
 */
import { describe, expect, it } from 'vitest';
import {
  BEATS_PER_PHRASE,
  beatGridFromBpm,
  describeTempo,
  foldBpm,
  guidanceGrid,
  isPlausibleBpm,
  tapTempoBpm,
} from './beat-grid';

describe('a beat grid from a known tempo', () => {
  it('puts a beat every 60/bpm seconds and a phrase every eight', () => {
    const grid = beatGridFromBpm(60, 32);
    expect(grid.bpm).toBe(60);
    expect(grid.beats[0]).toBe(0);
    expect(grid.beats[1]).toBe(1);
    expect(grid.beats).toHaveLength(33); // 0..32 inclusive
    expect(grid.phrases).toEqual([0, 8, 16, 24, 32]);
  });

  it('never runs past the end of the track', () => {
    const grid = beatGridFromBpm(72, 10);
    expect(Math.max(...grid.beats)).toBeLessThanOrEqual(10);
    expect(Math.max(...grid.phrases)).toBeLessThanOrEqual(10);
  });

  it('honours an offset for a track that does not start on a beat', () => {
    const grid = beatGridFromBpm(120, 10, { offsetSec: 0.25 });
    expect(grid.beats[0]).toBe(0.25);
    expect(grid.beats[1]).toBe(0.75);
    expect(grid.phrases[0]).toBe(0.25);
  });

  it('rounds to the millisecond so two machines agree exactly', () => {
    const grid = beatGridFromBpm(63, 20);
    for (const beat of grid.beats) {
      expect(Number.isInteger(Math.round(beat * 1000))).toBe(true);
      expect(beat).toBe(Math.round(beat * 1000) / 1000);
    }
  });

  it('refuses a tempo nobody could have meant', () => {
    expect(() => beatGridFromBpm(0, 60)).toThrow(RangeError);
    expect(() => beatGridFromBpm(900, 60)).toThrow(RangeError);
    expect(() => beatGridFromBpm(72, 0)).toThrow(RangeError);
  });

  it('agrees with itself about what a phrase is', () => {
    const grid = beatGridFromBpm(90, 60);
    const spacing = grid.phrases[1]! - grid.phrases[0]!;
    expect(spacing).toBeCloseTo((60 / 90) * BEATS_PER_PHRASE, 3);
  });
});

describe('octave folding', () => {
  it('halves a detector that counted the off-beats', () => {
    expect(foldBpm(152)).toBeCloseTo(76, 5);
    expect(foldBpm(160)).toBeCloseTo(80, 5);
  });

  it('doubles a tempo counted in bars', () => {
    expect(foldBpm(38)).toBeCloseTo(76, 5);
  });

  it('leaves a comfortable tempo alone', () => {
    expect(foldBpm(72)).toBe(72);
    expect(foldBpm(100)).toBe(100);
  });
});

describe('tap tempo', () => {
  /** Eight taps at exactly 80 BPM = 750 ms apart. */
  const steady = Array.from({ length: 8 }, (_, i) => 1_000 + i * 750);

  it('reads a steady tap', () => {
    const result = tapTempoBpm(steady);
    expect(result?.bpm).toBeCloseTo(80, 1);
    expect(result?.confidence).toBeGreaterThan(0.9);
    expect(result?.usedTaps).toBe(8);
  });

  it('forgives one distracted tap', () => {
    // The fifth tap lands 180 ms late and the sixth catches up.
    const wobbly = [...steady];
    wobbly[4] = (wobbly[4] as number) + 180;
    const result = tapTempoBpm(wobbly);
    expect(result?.bpm).toBeCloseTo(80, 0);
  });

  it('needs three taps before it will say anything', () => {
    expect(tapTempoBpm([1000])).toBeUndefined();
    expect(tapTempoBpm([1000, 1750])).toBeUndefined();
    expect(tapTempoBpm([1000, 1750, 2500])).toBeDefined();
  });

  it('reports low confidence for tapping that was all over the place', () => {
    const messy = [0, 400, 1400, 1600, 2900, 3100, 4400];
    const result = tapTempoBpm(messy);
    if (result) expect(result.confidence).toBeLessThan(0.5);
  });

  it('refuses a tempo outside anything human', () => {
    // Ten taps in a hundred milliseconds: somebody leaning on the button.
    expect(tapTempoBpm(Array.from({ length: 10 }, (_, i) => i * 10))).toBeUndefined();
  });

  it('does not care what order the taps arrive in', () => {
    const shuffled = [...steady].reverse();
    expect(tapTempoBpm(shuffled)?.bpm).toBeCloseTo(80, 1);
  });
});

describe('guidance grids for a song we never hear', () => {
  it('folds an implausible tap into the band before building a grid', () => {
    const grid = guidanceGrid(150, 60);
    expect(grid.bpm).toBeCloseTo(75, 5);
    expect(grid.phrases.length).toBeGreaterThan(1);
  });
});

describe('plausibility and words', () => {
  it('knows what a tempo can be', () => {
    expect(isPlausibleBpm(72)).toBe(true);
    expect(isPlausibleBpm(10)).toBe(false);
    expect(isPlausibleBpm(Number.NaN)).toBe(false);
  });

  it('describes a tempo in words rather than numbers alone', () => {
    expect(describeTempo(60)).toContain('very slow');
    expect(describeTempo(72)).toContain('walking pace');
    expect(describeTempo(120)).toContain('brisker');
  });
});
