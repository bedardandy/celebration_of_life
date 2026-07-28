/**
 * Working out the tempo of a recording nobody told us about.
 *
 * Only ever used for audio a family uploaded themselves — "Grandpa playing the
 * piano", a choir recording from 1998. Bundled tracks are synthesised at a
 * known BPM and never come near this file, because a detector's guess is always
 * worse than a number we chose.
 *
 * The decode is deliberately small: mono, 22.05 kHz, and at most ninety
 * seconds. Beat tracking does not get better with more samples, and a family's
 * eight-minute recording should not cost a worker a gigabyte of memory.
 */
// The reference is load-bearing rather than stylistic, which is why the rule is
// off for this one line: `music-tempo` ships no types, and a package that
// compiles this file as part of *its* program (@col/core does) picks up the
// ambient declaration only if the file needing it points at the file providing
// it. An `import` of a .d.ts would not do that.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./music-tempo.d.ts" />
import MusicTempo from 'music-tempo';
import { runFfmpeg } from './ffmpeg';
import { beatGridFromBpm, foldBpm, isPlausibleBpm } from './beat-grid';
import type { BeatGrid } from '@col/schemas';

/**
 * 44.1 kHz because music-tempo's defaults are expressed in samples: its 441
 * sample hop is one hundredth of a second only at this rate, and its idea of
 * "when" is hop counts multiplied by that step. Feed it 22 kHz without saying
 * so and every tempo it reports is exactly double.
 */
export const ANALYSIS_SAMPLE_RATE = 44_100;
/** Frames the detector steps by. Its default, restated so the maths is visible. */
export const ANALYSIS_HOP_SIZE = 441;
/** Ninety seconds is more than any tempo estimator needs. */
export const ANALYSIS_MAX_SEC = 90;

export type TempoEstimate = {
  bpm: number;
  /** The estimator's raw answer, before octave folding. */
  rawBpm: number;
  /** 'detected' when the file was analysed, 'assumed' when it could not be. */
  source: 'detected' | 'assumed';
  beatGrid: BeatGrid;
};

/**
 * A slow, safe default for a recording we could not read a tempo from.
 *
 * 72 BPM is a walking pace and the middle of the band tribute music actually
 * lives in; snapping to an assumed grid is no worse than not snapping at all,
 * and the phrase boundaries still stop slides changing at random moments.
 */
export const ASSUMED_BPM = 72;

/** Decode any audio file ffmpeg understands into mono float samples. */
export async function decodeToMono(
  file: string,
  options: { sampleRate?: number; maxSeconds?: number } = {},
): Promise<Float32Array> {
  const sampleRate = options.sampleRate ?? ANALYSIS_SAMPLE_RATE;
  const maxSeconds = options.maxSeconds ?? ANALYSIS_MAX_SEC;

  const result = await runFfmpeg(
    [
      '-hide_banner',
      '-nostdin',
      '-i',
      file,
      '-t',
      String(maxSeconds),
      '-ac',
      '1',
      '-ar',
      String(sampleRate),
      '-f',
      'f32le',
      '-acodec',
      'pcm_f32le',
      'pipe:1',
    ],
    { timeoutMs: 120_000, binaryStdout: true },
  );

  const buffer = result.stdoutBuffer ?? Buffer.alloc(0);
  const usable = buffer.byteLength - (buffer.byteLength % 4);
  const out = new Float32Array(usable / 4);
  for (let i = 0; i < out.length; i += 1) out[i] = buffer.readFloatLE(i * 4);
  return out;
}

/**
 * Tempo, and the grid that follows from it.
 *
 * Never throws: an unreadable or arrhythmic recording returns the assumed
 * tempo, marked as assumed, because the family's alternative is being told
 * their grandfather's piano recording is unsuitable.
 */
export async function estimateTempo(
  file: string,
  durationSec: number,
  options: { sampleRate?: number } = {},
): Promise<TempoEstimate> {
  const sampleRate = options.sampleRate ?? ANALYSIS_SAMPLE_RATE;
  let rawBpm = Number.NaN;

  try {
    const samples = await decodeToMono(file, { sampleRate });
    if (samples.length > sampleRate * 3) {
      const analysis = new MusicTempo(samples, {
        hopSize: ANALYSIS_HOP_SIZE,
        // Stated rather than defaulted: this is the only line tying the
        // detector's frame counter to real seconds.
        timeStep: ANALYSIS_HOP_SIZE / sampleRate,
      }) as { tempo?: string | number };
      rawBpm = Number(analysis.tempo);
    }
  } catch {
    rawBpm = Number.NaN;
  }

  if (!isPlausibleBpm(rawBpm)) {
    return {
      bpm: ASSUMED_BPM,
      rawBpm: Number.isFinite(rawBpm) ? rawBpm : 0,
      source: 'assumed',
      beatGrid: beatGridFromBpm(ASSUMED_BPM, durationSec),
    };
  }

  const bpm = Math.round(foldBpm(rawBpm) * 10) / 10;
  return {
    bpm,
    rawBpm: Math.round(rawBpm * 10) / 10,
    source: 'detected',
    beatGrid: beatGridFromBpm(bpm, durationSec),
  };
}
