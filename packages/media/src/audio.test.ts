/**
 * The audio graph, checked without an encode.
 *
 * Everything here is a string of ffmpeg arguments or a parse of ffmpeg's
 * output, which means it can be tested exactly and quickly — and it has to be,
 * because these are the arguments that decide whether a video is the right
 * length and the right loudness, and both of those failures only show up in a
 * room full of people.
 *
 * The WAV writer is here too, since the music library is built on it.
 */
import { describe, expect, it } from 'vitest';
import {
  FADE_IN_SEC,
  FADE_OUT_SEC,
  LOUDNESS_TARGETS,
  loudnormApplyFilter,
  loudnormMeasureFilter,
  muxArgs,
  parseLoudnormJson,
  planMusicBed,
} from './audio';
import { encodeWav, toInt16 } from './wav';

describe('fitting music to a video', () => {
  it('trims a long track and fades it at both ends', () => {
    const plan = planMusicBed({ sourceDurationSec: 200, targetDurationSec: 90 });
    expect(plan.loops).toBe(0);
    expect(plan.looped).toBe(false);
    expect(plan.filter).toContain('atrim=start=0:duration=90');
    expect(plan.filter).toContain(`afade=t=in:st=0:d=${FADE_IN_SEC}`);
    // Out fade starts three seconds before the end and lasts three seconds.
    expect(plan.filter).toContain(`afade=t=out:st=87:d=${FADE_OUT_SEC}`);
  });

  it('loops a short track far enough to cover the video, with room to spare', () => {
    const plan = planMusicBed({ sourceDurationSec: 10, targetDurationSec: 45 });
    expect(plan.looped).toBe(true);
    // 10s of music, 45s of video: four more passes covers it, and we ask for
    // one beyond that so a rounding error cannot leave silence at the end.
    expect(plan.loops).toBeGreaterThanOrEqual(4);
    expect((plan.loops + 1) * 10).toBeGreaterThan(45);
  });

  it('starts where the family asked it to', () => {
    const plan = planMusicBed({
      sourceDurationSec: 200,
      targetDurationSec: 60,
      startOffsetSec: 32.5,
    });
    expect(plan.filter).toContain('atrim=start=32.5:duration=60');
  });

  it('never starts past the end of the track', () => {
    const plan = planMusicBed({ sourceDurationSec: 20, targetDurationSec: 30, startOffsetSec: 90 });
    expect(plan.filter).toContain('atrim=start=19:');
    expect(plan.looped).toBe(true);
  });

  it('shrinks the fades rather than dropping them on a very short video', () => {
    const plan = planMusicBed({ sourceDurationSec: 200, targetDurationSec: 3 });
    expect(plan.fadeInSec).toBe(1);
    expect(plan.fadeOutSec).toBe(1);
    expect(plan.filter).toContain('afade=t=in:st=0:d=1');
    expect(plan.filter).toContain('afade=t=out:st=2:d=1');
  });

  it('forces stereo at 48 kHz whatever went in', () => {
    const plan = planMusicBed({ sourceDurationSec: 60, targetDurationSec: 30 });
    expect(plan.filter).toContain('sample_rates=48000');
    expect(plan.filter).toContain('channel_layouts=stereo');
  });

  it('refuses lengths that cannot mean anything', () => {
    expect(() => planMusicBed({ sourceDurationSec: 0, targetDurationSec: 10 })).toThrow(RangeError);
    expect(() => planMusicBed({ sourceDurationSec: 10, targetDurationSec: 0 })).toThrow(RangeError);
  });
});

describe('the two-pass loudness normalisation', () => {
  const measured = {
    input_i: -23.4,
    input_tp: -6.2,
    input_lra: 5.1,
    input_thresh: -33.9,
    target_offset: 0.3,
  };

  it('measures without changing anything on the first pass', () => {
    const filter = loudnormMeasureFilter();
    expect(filter).toBe('loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json');
    expect(filter).not.toContain('measured_');
  });

  it('hands the measurements back on the second pass, in linear mode', () => {
    const filter = loudnormApplyFilter(measured);
    expect(filter).toContain('I=-16');
    expect(filter).toContain('measured_I=-23.4');
    expect(filter).toContain('measured_TP=-6.2');
    expect(filter).toContain('measured_LRA=5.1');
    expect(filter).toContain('measured_thresh=-33.9');
    expect(filter).toContain('offset=0.3');
    // Linear is the entire reason for doing this twice: one constant gain
    // instead of a compressor riding quiet, dynamic music.
    expect(filter).toContain('linear=true');
  });

  it('uses the targets it is given', () => {
    expect(loudnormApplyFilter(measured, { i: -14, tp: -1, lra: 7 })).toContain('I=-14');
    expect(LOUDNESS_TARGETS.i).toBe(-16);
  });

  it('reads the measurement block out of a chatty log', () => {
    const stderr = [
      'ffmpeg version 6.1.1 Copyright (c) 2000-2023',
      '[Parsed_loudnorm_0 @ 0x55] ',
      '{',
      '\t"input_i" : "-23.40",',
      '\t"input_tp" : "-6.20",',
      '\t"input_lra" : "5.10",',
      '\t"input_thresh" : "-33.90",',
      '\t"output_i" : "-16.01",',
      '\t"normalization_type" : "dynamic",',
      '\t"target_offset" : "0.30"',
      '}',
    ].join('\n');

    expect(parseLoudnormJson(stderr)).toEqual(measured);
  });

  it('takes the last block when both passes printed one', () => {
    const block = (i: string) =>
      `{"input_i" : "${i}", "input_tp" : "-2.0", "input_lra" : "4.0", "input_thresh" : "-30.0", "target_offset" : "0.0"}`;
    const parsed = parseLoudnormJson(`${block('-30.0')}\nsome noise\n${block('-16.0')}`);
    expect(parsed?.input_i).toBe(-16);
  });

  it('survives the -inf that silence produces', () => {
    const stderr =
      '{"input_i" : "-inf", "input_tp" : "-inf", "input_lra" : "0.00", "input_thresh" : "-inf", "target_offset" : "0.00"}';
    const parsed = parseLoudnormJson(stderr);
    expect(parsed).toBeDefined();
    expect(parsed?.input_i).toBeLessThan(-100);
  });

  it('returns nothing rather than guessing when there is no block', () => {
    expect(parseLoudnormJson('ffmpeg had a bad day')).toBeUndefined();
    expect(parseLoudnormJson('')).toBeUndefined();
  });
});

describe('the mux', () => {
  const args = muxArgs({ videoFile: 'v.mp4', audioFile: 'a.m4a', outputFile: 'out.mp4' });

  it('re-encodes neither stream', () => {
    expect(args.join(' ')).toContain('-c:v copy');
    expect(args.join(' ')).toContain('-c:a copy');
  });

  it('puts the index at the front, which is what makes it play off a stick', () => {
    expect(args).toContain('+faststart');
  });

  it('takes the picture from the first input and the sound from the second', () => {
    expect(args.join(' ')).toContain('-map 0:v:0');
    expect(args.join(' ')).toContain('-map 1:a:0');
  });
});

describe('writing a WAV by hand', () => {
  it('writes a RIFF header the rest of the world can read', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1]);
    const wav = encodeWav([samples, samples], { sampleRate: 44100, channels: 2 });

    expect(wav.toString('latin1', 0, 4)).toBe('RIFF');
    expect(wav.toString('latin1', 8, 12)).toBe('WAVE');
    expect(wav.readUInt16LE(22)).toBe(2); // stereo
    expect(wav.readUInt32LE(24)).toBe(44100);
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
    expect(wav.toString('latin1', 36, 40)).toBe('data');
    expect(wav.readUInt32LE(40)).toBe(4 * 2 * 2);
    expect(wav.length).toBe(44 + 16);
  });

  it('does not wrap a full-scale sample round to silence', () => {
    expect(toInt16(1)).toBe(32767);
    expect(toInt16(-1)).toBe(-32767);
    expect(toInt16(2)).toBe(32767);
    expect(toInt16(0)).toBe(0);
  });

  it('refuses channels of different lengths rather than stuttering one side', () => {
    expect(() => encodeWav([new Float32Array(4), new Float32Array(3)])).toThrow(RangeError);
  });
});
