import { describe, expect, it } from 'vitest';
import {
  FfmpegError,
  FfmpegMissingError,
  checkFfmpeg,
  ffmpegPath,
  ffprobePath,
  runFfprobe,
} from './ffmpeg';

describe('binary resolution', () => {
  it('defaults to PATH lookup and honours env overrides', () => {
    delete process.env.FFMPEG_PATH;
    delete process.env.FFPROBE_PATH;
    expect(ffmpegPath()).toBe('ffmpeg');
    expect(ffprobePath()).toBe('ffprobe');

    process.env.FFPROBE_PATH = '/opt/homebrew/bin/ffprobe';
    expect(ffprobePath()).toBe('/opt/homebrew/bin/ffprobe');
    delete process.env.FFPROBE_PATH;
  });
});

describe('runFfprobe', () => {
  it('runs `ffprobe -version` and captures output', async () => {
    const result = await runFfprobe(['-version']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/ffprobe version/i);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('rejects with FfmpegError on a bad invocation', async () => {
    await expect(runFfprobe(['--definitely-not-a-flag'])).rejects.toBeInstanceOf(FfmpegError);
  });

  it('allowNonZeroExit resolves instead of throwing', async () => {
    const result = await runFfprobe(['--definitely-not-a-flag'], { allowNonZeroExit: true });
    expect(result.code).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it('gives an actionable error when the binary is missing', async () => {
    process.env.FFPROBE_PATH = 'ffprobe-that-does-not-exist';
    try {
      await expect(runFfprobe(['-version'])).rejects.toBeInstanceOf(FfmpegMissingError);
      await expect(runFfprobe(['-version'])).rejects.toThrow(/apt-get install -y ffmpeg/);
    } finally {
      delete process.env.FFPROBE_PATH;
    }
  });
});

describe('checkFfmpeg', () => {
  it('reports both binaries as available in this environment', async () => {
    const check = await checkFfmpeg();
    expect(check.ok).toBe(true);
    expect(check.ffmpeg.ok).toBe(true);
    expect(check.ffprobe.ok).toBe(true);
    expect(check.message).toMatch(/ffmpeg ready/);
  });

  it('never throws when a binary is missing — it reports', async () => {
    process.env.FFMPEG_PATH = 'ffmpeg-that-does-not-exist';
    try {
      const check = await checkFfmpeg();
      expect(check.ok).toBe(false);
      expect(check.ffmpeg.ok).toBe(false);
      expect(check.message).toMatch(/brew install ffmpeg/);
    } finally {
      delete process.env.FFMPEG_PATH;
    }
  });
});
