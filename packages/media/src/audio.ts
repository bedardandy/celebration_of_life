/**
 * The audio half of a tribute video.
 *
 * Everything a family hears in the room is decided here, and almost all of it
 * is about not making the funeral director's afternoon worse:
 *
 *  - the music is trimmed (or looped) to exactly the length of the video, so it
 *    never stops before the last photograph or run on into the eulogy;
 *  - it fades in over a second and a half and out over three, because a track
 *    that starts at full volume makes a room flinch and one that stops dead
 *    makes them think something broke;
 *  - it is normalised to −16 LUFS in two passes, because a video that is
 *    quieter than the one before it on the same laptop is a person walking to
 *    the back of a chapel to turn a dial up;
 *  - the container is AAC in MP4 with the moov atom at the front, because a
 *    file that will not play on the venue's machine is the catastrophic failure
 *    of this entire product.
 *
 * The argument builders are separated from the processes that run them so the
 * filter graphs can be unit-tested without an encode. Everything shells out
 * through `runFfmpeg`/`runFfprobe`.
 */
import { open } from 'node:fs/promises';
import { probe, runFfmpeg, type RunOptions } from './ffmpeg';

/* -------------------------------------------------------------------------- */
/* the numbers                                                                 */
/* -------------------------------------------------------------------------- */

/** Long enough to be a beginning, short enough not to lose the first phrase. */
export const FADE_IN_SEC = 1.5;
/** The room needs a moment after the last photograph. Three seconds is it. */
export const FADE_OUT_SEC = 3;

/**
 * Broadcast-adjacent loudness targets. −16 LUFS is the streaming convention for
 * stereo material and sits comfortably on laptop speakers and chapel PAs alike;
 * −1.5 dBTP leaves headroom for the lossy encoder to overshoot into.
 */
export const LOUDNESS_TARGETS = { i: -16, tp: -1.5, lra: 11 } as const;
/** Structural rather than `typeof LOUDNESS_TARGETS`: a caller may target −14. */
export type LoudnessTargets = { i: number; tp: number; lra: number };

export const AUDIO_SAMPLE_RATE = 48_000;
export const AUDIO_BITRATE = '192k';

/* -------------------------------------------------------------------------- */
/* the music bed                                                               */
/* -------------------------------------------------------------------------- */

export type MusicBedShape = {
  /** How long the track itself is. */
  sourceDurationSec: number;
  /** How long the video is, and therefore how long the bed must be. */
  targetDurationSec: number;
  /** Where in the track to start, when a family picked a later moment. */
  startOffsetSec?: number;
  fadeInSec?: number;
  fadeOutSec?: number;
};

export type MusicBedPlan = {
  /** `-stream_loop` count: 0 means the track is long enough on its own. */
  loops: number;
  /** The filter chain, ready for `-af`. */
  filter: string;
  fadeInSec: number;
  fadeOutSec: number;
  /** True when the track had to be repeated to cover the video. */
  looped: boolean;
};

/**
 * How to turn one track into exactly `targetDurationSec` of audio.
 *
 * Looping is a compromise and is treated as one: the loop point is audible on
 * most material, so we only ever loop when the video is genuinely longer than
 * the music, and the fade-out is the thing that covers the last seam.
 *
 * The fades are clamped rather than refused when the video is very short — a
 * forty-second family cut still gets a fade in and out, just proportionally
 * smaller ones, because "no fade" is a worse answer than "a quick fade".
 */
export function planMusicBed(shape: MusicBedShape): MusicBedPlan {
  const target = shape.targetDurationSec;
  if (!(target > 0)) throw new RangeError(`target duration must be positive: ${target}`);
  const source = shape.sourceDurationSec;
  if (!(source > 0)) throw new RangeError(`source duration must be positive: ${source}`);

  const offset = Math.max(0, Math.min(shape.startOffsetSec ?? 0, Math.max(0, source - 1)));
  const available = source - offset;
  // One extra repeat beyond the arithmetic, so a rounding error at the tail
  // cannot leave the last half-second of a video in silence.
  const loops = available >= target ? 0 : Math.ceil((target - available) / source) + 1;

  const fadeIn = Math.min(shape.fadeInSec ?? FADE_IN_SEC, target / 3);
  const fadeOut = Math.min(shape.fadeOutSec ?? FADE_OUT_SEC, target / 3);
  const fadeOutStart = Math.max(0, target - fadeOut);

  const filter = [
    // A stereo, 48 kHz bed regardless of what the source was: mono music behind
    // a video that is otherwise stereo is a "one speaker is broken" phone call.
    `aformat=sample_fmts=fltp:sample_rates=${AUDIO_SAMPLE_RATE}:channel_layouts=stereo`,
    // `duration` is the length of the *output*, counted from `start`.
    `atrim=start=${fixed(offset)}:duration=${fixed(target)}`,
    'asetpts=PTS-STARTPTS',
    `afade=t=in:st=0:d=${fixed(fadeIn)}`,
    `afade=t=out:st=${fixed(fadeOutStart)}:d=${fixed(fadeOut)}`,
  ].join(',');

  return { loops, filter, fadeInSec: fadeIn, fadeOutSec: fadeOut, looped: loops > 0 };
}

/** Six decimal places, no exponent: ffmpeg filter syntax has no opinion on 1e-7. */
function fixed(seconds: number): string {
  return (Math.round(seconds * 1e6) / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0';
}

/* -------------------------------------------------------------------------- */
/* loudness                                                                    */
/* -------------------------------------------------------------------------- */

export type LoudnessMeasurement = {
  input_i: number;
  input_tp: number;
  input_lra: number;
  input_thresh: number;
  target_offset: number;
};

/** Pass one: measure, changing nothing. */
export function loudnormMeasureFilter(targets: LoudnessTargets = LOUDNESS_TARGETS): string {
  return `loudnorm=I=${targets.i}:TP=${targets.tp}:LRA=${targets.lra}:print_format=json`;
}

/**
 * Pass two: apply, told what pass one found.
 *
 * `linear=true` is the point of doing this twice — with the measurements in
 * hand ffmpeg can apply one constant gain rather than riding a compressor over
 * the material, and a tribute video is exactly the sort of quiet, dynamic
 * material that dynamic normalisation makes sound pumped and cheap.
 */
export function loudnormApplyFilter(
  measured: LoudnessMeasurement,
  targets: LoudnessTargets = LOUDNESS_TARGETS,
): string {
  return [
    `loudnorm=I=${targets.i}`,
    `TP=${targets.tp}`,
    `LRA=${targets.lra}`,
    `measured_I=${measured.input_i}`,
    `measured_TP=${measured.input_tp}`,
    `measured_LRA=${measured.input_lra}`,
    `measured_thresh=${measured.input_thresh}`,
    `offset=${measured.target_offset}`,
    'linear=true',
    'print_format=json',
  ].join(':');
}

/**
 * Pull the measurement block out of ffmpeg's stderr.
 *
 * loudnorm prints its JSON at the very end of a chatty log, and prints it again
 * on the second pass, so the *last* well-formed block is the one that describes
 * what actually happened. `-inf` appears for silence and is not JSON, so it is
 * repaired before parsing rather than thrown away — a silent stretch is a fact
 * about the audio, not a parse failure.
 */
export function parseLoudnormJson(stderr: string): LoudnessMeasurement | undefined {
  const blocks = [...stderr.matchAll(/\{[^{}]*"input_i"[^{}]*\}/g)].map((m) => m[0]);
  const last = blocks[blocks.length - 1];
  if (!last) return undefined;
  try {
    const raw = JSON.parse(last.replace(/"(-?)inf"/g, '"$1120"')) as Record<string, string>;
    const measurement = {
      input_i: Number(raw['input_i']),
      input_tp: Number(raw['input_tp']),
      input_lra: Number(raw['input_lra']),
      input_thresh: Number(raw['input_thresh']),
      target_offset: Number(raw['target_offset']),
    };
    return Object.values(measurement).every((n) => Number.isFinite(n)) ? measurement : undefined;
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* building the audio track                                                    */
/* -------------------------------------------------------------------------- */

export type MusicBedOptions = MusicBedShape & {
  trackFile: string;
  outputFile: string;
  targets?: LoudnessTargets;
  run?: RunOptions;
};

export type MusicBedResult = MusicBedPlan & {
  outputFile: string;
  measured?: LoudnessMeasurement;
  /** True when pass one could not be read and a single-pass fallback was used. */
  singlePass: boolean;
};

/**
 * Track in, one AAC file of exactly the right length out.
 *
 * If the measuring pass cannot be read — an ffmpeg build that prints something
 * unexpected, a very short clip — this falls back to a single dynamic pass
 * rather than failing the render. A slightly less perfectly normalised video is
 * a small problem; no video the day before a funeral is not.
 */
export async function buildMusicBed(options: MusicBedOptions): Promise<MusicBedResult> {
  const targets = options.targets ?? LOUDNESS_TARGETS;
  const plan = planMusicBed(options);
  const loopArgs = plan.loops > 0 ? ['-stream_loop', String(plan.loops)] : [];

  const measurePass = await runFfmpeg(
    [
      '-hide_banner',
      '-nostdin',
      ...loopArgs,
      '-i',
      options.trackFile,
      '-af',
      `${plan.filter},${loudnormMeasureFilter(targets)}`,
      '-f',
      'null',
      '-',
    ],
    { timeoutMs: 300_000, ...options.run },
  );

  const measured = parseLoudnormJson(measurePass.stderr);
  const normalise = measured
    ? loudnormApplyFilter(measured, targets)
    : loudnormMeasureFilter(targets);

  await runFfmpeg(
    [
      '-hide_banner',
      '-nostdin',
      '-y',
      ...loopArgs,
      '-i',
      options.trackFile,
      '-af',
      // loudnorm resamples internally; put it back where the muxer expects it.
      `${plan.filter},${normalise},aresample=${AUDIO_SAMPLE_RATE}`,
      '-c:a',
      'aac',
      '-b:a',
      AUDIO_BITRATE,
      '-ar',
      String(AUDIO_SAMPLE_RATE),
      '-ac',
      '2',
      '-movflags',
      '+faststart',
      options.outputFile,
    ],
    { timeoutMs: 300_000, ...options.run },
  );

  return {
    ...plan,
    outputFile: options.outputFile,
    ...(measured ? { measured } : {}),
    singlePass: measured === undefined,
  };
}

export type SilentTrackOptions = {
  outputFile: string;
  durationSec: number;
  run?: RunOptions;
};

/**
 * A silent AAC track, for the side-loaded mode.
 *
 * Not "no audio stream": a file with no audio at all makes some venue players
 * report an error, and makes others refuse to seek. A real, silent stream of
 * the right length behaves like every other video the machine has ever played,
 * and the room hears the song from the venue's own system.
 */
export async function buildSilentTrack(options: SilentTrackOptions): Promise<string> {
  await runFfmpeg(
    [
      '-hide_banner',
      '-nostdin',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `anullsrc=channel_layout=stereo:sample_rate=${AUDIO_SAMPLE_RATE}`,
      '-t',
      fixed(options.durationSec),
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      options.outputFile,
    ],
    { timeoutMs: 120_000, ...options.run },
  );
  return options.outputFile;
}

export type MuxOptions = {
  videoFile: string;
  audioFile: string;
  outputFile: string;
  run?: RunOptions;
};

/**
 * Put the picture and the sound in one file, re-encoding neither.
 *
 * `-shortest` guards the case where the two differ by a frame; `+faststart`
 * moves the index to the front so the file starts playing before it has
 * finished loading — which is what makes it work off a USB stick on a slow
 * venue machine, and off a link in an email.
 */
export function muxArgs(options: MuxOptions): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-i',
    options.videoFile,
    '-i',
    options.audioFile,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c:v',
    'copy',
    '-c:a',
    'copy',
    '-shortest',
    '-movflags',
    '+faststart',
    options.outputFile,
  ];
}

export async function muxAudioIntoVideo(options: MuxOptions): Promise<string> {
  await runFfmpeg(muxArgs(options), { timeoutMs: 600_000, ...options.run });
  return options.outputFile;
}

/* -------------------------------------------------------------------------- */
/* verification                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Top-level MP4 box names, in file order.
 *
 * Read from the bytes rather than inferred from an ffprobe log: whether `moov`
 * comes before `mdat` is a fact about the file, and this is the one claim we
 * make to a funeral director that we cannot afford to be wrong about.
 */
export async function topLevelAtoms(file: string, limit = 12): Promise<string[]> {
  const handle = await open(file, 'r');
  try {
    const out: string[] = [];
    let offset = 0;
    const header = Buffer.alloc(16);
    for (let i = 0; i < limit; i += 1) {
      const { bytesRead } = await handle.read(header, 0, 16, offset);
      if (bytesRead < 8) break;
      let size = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      if (!/^[\x20-\x7e]{4}$/.test(type)) break;
      out.push(type);
      if (size === 1) {
        if (bytesRead < 16) break;
        size = Number(header.readBigUInt64BE(8));
      } else if (size === 0) {
        break; // extends to end of file
      }
      if (size < 8) break;
      offset += size;
    }
    return out;
  } finally {
    await handle.close();
  }
}

export async function isFaststart(file: string): Promise<boolean> {
  const atoms = await topLevelAtoms(file);
  const moov = atoms.indexOf('moov');
  const mdat = atoms.indexOf('mdat');
  return moov >= 0 && (mdat < 0 || moov < mdat);
}

export type DeliverableExpectation = {
  /** The timeline's length. The file must match it within half a second. */
  durationSec: number;
  toleranceSec?: number;
  width?: number;
  height?: number;
  /** Side-loaded files carry a silent AAC track; both modes require one. */
  requireAudio?: boolean;
};

export type DeliverableCheck = {
  ok: boolean;
  /** Plain-language reasons the file is not deliverable. Empty when ok. */
  problems: string[];
  videoCodec?: string;
  pixelFormat?: string;
  audioCodec?: string;
  width?: number;
  height?: number;
  durationSec?: number;
  faststart: boolean;
  formatName?: string;
  byteSize?: number;
};

/**
 * The gate every render passes before anyone is told it is ready.
 *
 * H.264 High/Main in yuv420p, AAC audio, MP4, moov first, and the length the
 * timeline promised. These are not quality checks — a render can be beautiful
 * and still be yuvj420p, which is the classic "played fine at home, came out
 * green on the projector" failure.
 */
export async function verifyDeliverable(
  file: string,
  expectation: DeliverableExpectation,
): Promise<DeliverableCheck> {
  const meta = await probe(file);
  const streams: Record<string, any>[] = Array.isArray(meta['streams']) ? meta['streams'] : [];
  const video = streams.find((s) => s['codec_type'] === 'video');
  const audio = streams.find((s) => s['codec_type'] === 'audio');
  const format = (meta['format'] ?? {}) as Record<string, any>;

  const durationSec = Number(format['duration']);
  const faststart = await isFaststart(file);
  const tolerance = expectation.toleranceSec ?? 0.5;
  const problems: string[] = [];

  if (video?.['codec_name'] !== 'h264') {
    problems.push(`video is ${video?.['codec_name'] ?? 'missing'}, not H.264`);
  }
  if (video?.['pix_fmt'] !== 'yuv420p') {
    problems.push(`pixel format is ${video?.['pix_fmt'] ?? 'unknown'}, not yuv420p`);
  }
  if ((expectation.requireAudio ?? true) && audio?.['codec_name'] !== 'aac') {
    problems.push(`audio is ${audio?.['codec_name'] ?? 'missing'}, not AAC`);
  }
  if (!String(format['format_name'] ?? '').includes('mp4')) {
    problems.push(`container is ${format['format_name'] ?? 'unknown'}, not MP4`);
  }
  if (!faststart) problems.push('the index (moov) is not at the front of the file');
  if (!Number.isFinite(durationSec)) {
    problems.push('the file has no readable duration');
  } else if (Math.abs(durationSec - expectation.durationSec) > tolerance) {
    problems.push(
      `it runs ${durationSec.toFixed(2)}s, and the slideshow is ${expectation.durationSec.toFixed(2)}s`,
    );
  }
  if (expectation.width && video?.['width'] !== expectation.width) {
    problems.push(`it is ${video?.['width']} pixels wide, not ${expectation.width}`);
  }
  if (expectation.height && video?.['height'] !== expectation.height) {
    problems.push(`it is ${video?.['height']} pixels tall, not ${expectation.height}`);
  }

  return {
    ok: problems.length === 0,
    problems,
    videoCodec: video?.['codec_name'],
    pixelFormat: video?.['pix_fmt'],
    audioCodec: audio?.['codec_name'],
    width: video?.['width'],
    height: video?.['height'],
    durationSec: Number.isFinite(durationSec) ? durationSec : undefined,
    faststart,
    formatName: format['format_name'],
    byteSize: Number(format['size']) || undefined,
  };
}

/**
 * Measure a finished file's loudness, for the render's own assertion.
 *
 * The same loudnorm analysis pass, run over the delivered MP4 rather than over
 * the music: this is how a test can say "−16 LUFS, within a decibel and a half"
 * about the thing a family will actually download.
 */
export async function measureLoudness(
  file: string,
  targets: LoudnessTargets = LOUDNESS_TARGETS,
): Promise<LoudnessMeasurement | undefined> {
  const result = await runFfmpeg(
    [
      '-hide_banner',
      '-nostdin',
      '-i',
      file,
      '-af',
      loudnormMeasureFilter(targets),
      '-f',
      'null',
      '-',
    ],
    { timeoutMs: 300_000 },
  );
  return parseLoudnormJson(result.stderr);
}

/** Length of any media file, in seconds, or undefined if it has none. */
export async function mediaDurationSec(file: string): Promise<number | undefined> {
  const meta = await probe(file);
  const duration = Number((meta['format'] as Record<string, any> | undefined)?.['duration']);
  return Number.isFinite(duration) ? duration : undefined;
}
