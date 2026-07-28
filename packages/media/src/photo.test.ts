/**
 * The pipeline, against the fixture set.
 *
 * These are the assertions that stand between a family and a slideshow full of
 * sideways duplicates, so they are written against real bytes rather than mocks:
 * fixtures/photos holds a HEIC, a photo carrying EXIF orientation 6, two shots
 * of one moment, a deliberately blurred frame, and a file that is not a photo.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { eraGuess, eraStartYear, isPlausibleCaptureTime, readExif } from './exif';
import {
  DUPE_HAMMING_THRESHOLD,
  groupNearDuplicates,
  isValidPhash,
  looksLikeSameMoment,
  perceptualHash,
  phashDistance,
  pickRepresentative,
} from './phash';
import {
  BLURRY_SCORE_THRESHOLD,
  isBlurry,
  measureQuality,
  measureQualityFromGray,
  sharpnessScore,
} from './quality';
import {
  extensionForMime,
  isImageMime,
  isVideoMime,
  normalizeToJpeg,
  normalizeUploadMime,
  processPhoto,
  UnreadableMediaError,
  VARIANT_EDGES,
} from './photo';

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'fixtures',
  'photos',
);

const fixture = (name: string) => readFile(path.join(FIXTURES, name));

describe('EXIF reading', () => {
  it('never throws on a file with no metadata worth the name', async () => {
    await expect(readExif(Buffer.from('nonsense'))).resolves.toEqual({});
  });

  it('reads the orientation a phone wrote', async () => {
    const facts = await readExif(await fixture('07-sideways.jpg'));
    expect(facts.orientation).toBe(6);
  });

  it('reads a capture time and keeps it in epoch milliseconds', async () => {
    const withDate = await sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      // IFD2 is the Exif sub-IFD, which is where a camera writes this tag.
      .withExif({ IFD2: { DateTimeOriginal: '2004:07:19 14:03:11' } })
      .jpeg()
      .toBuffer();

    const facts = await readExif(withDate);
    expect(facts.takenAt).toBeTypeOf('number');
    expect(new Date(facts.takenAt as number).getUTCFullYear()).toBe(2004);
  });

  it('refuses dates a life cannot contain, rather than inventing a decade', () => {
    const now = Date.UTC(2026, 0, 1);
    expect(isPlausibleCaptureTime(Date.UTC(1975, 5, 4), now)).toBe(true);
    expect(isPlausibleCaptureTime(Date.UTC(1780, 0, 1), now)).toBe(false);
    expect(isPlausibleCaptureTime(Date.UTC(2031, 0, 1), now)).toBe(false);
    expect(isPlausibleCaptureTime(Number.NaN, now)).toBe(false);
  });

  it('guesses a decade, and says nothing when it cannot', () => {
    expect(eraGuess(Date.UTC(1962, 3, 2))).toBe('1960s');
    expect(eraGuess(Date.UTC(2004, 11, 31))).toBe('2000s');
    expect(eraGuess(null)).toBeUndefined();
    expect(eraGuess(undefined)).toBeUndefined();
    expect(eraStartYear('1960s')).toBe(1960);
    expect(eraStartYear('when-was-this')).toBeUndefined();
  });
});

describe('EXIF rotation', () => {
  it('brings a sideways photo upright, and says so in the dimensions', async () => {
    const bytes = await fixture('07-sideways.jpg');
    const before = await sharp(bytes).metadata();
    expect(before.width).toBe(640);
    expect(before.height).toBe(480);
    expect(before.orientation).toBe(6);

    const processed = await processPhoto(bytes);
    // 640×480 tagged "rotate 90" is a 480×640 photograph.
    expect(processed.width).toBe(480);
    expect(processed.height).toBe(640);

    // And the tag is gone, so nothing downstream rotates it a second time.
    const upright = await normalizeToJpeg(bytes);
    const meta = await sharp(upright.data).metadata();
    expect(meta.orientation ?? 1).toBe(1);
    expect(meta.width).toBe(480);
    expect(meta.height).toBe(640);
  });
});

describe('variants', () => {
  it('produces thumb320 / web1600 / render2400, never upscaling', async () => {
    const processed = await processPhoto(await fixture('01-portrait.jpg'));
    const names = processed.variants.map((v) => v.name);
    expect(names).toEqual(['thumb320', 'web1600', 'render2400']);

    for (const variant of processed.variants) {
      expect(variant.mime).toBe('image/jpeg');
      expect(variant.byteSize).toBeGreaterThan(0);
      const longest = Math.max(variant.width, variant.height);
      expect(longest).toBeLessThanOrEqual(VARIANT_EDGES[variant.name]);
    }

    const thumb = processed.variants[0];
    expect(Math.max(thumb?.width ?? 0, thumb?.height ?? 0)).toBe(320);
    // The source is 640 wide, so the bigger variants stay at source size.
    expect(processed.variants[1]?.width).toBe(640);
    expect(processed.variants[2]?.width).toBe(640);
  });

  it('converts HEIC to JPEG that anything can display', async () => {
    const processed = await processPhoto(await fixture('08-phone.heic'));
    expect(processed.sourceFormat).toBe('heif');
    expect(processed.width).toBe(640);
    for (const variant of processed.variants) {
      const meta = await sharp(variant.data).metadata();
      expect(meta.format).toBe('jpeg');
    }
  });
});

describe('perceptual hashing', () => {
  it('produces a 64-bit hash as a bit string', async () => {
    const hash = await perceptualHash(await fixture('01-portrait.jpg'));
    expect(isValidPhash(hash)).toBe(true);
    expect(hash).toHaveLength(64);
    expect(isValidPhash('nope')).toBe(false);
  });

  it('puts two shots of one moment far inside the threshold, and different photographs far outside it', async () => {
    const names = [
      '01-portrait.jpg',
      '02-beach.jpg',
      '03-wedding.jpg',
      '04-garden.jpg',
      '05-garden-near-duplicate.jpg',
      '06-blurry.jpg',
      '07-sideways.jpg',
    ];
    const hashes = new Map<string, string>();
    for (const name of names) {
      const upright = await normalizeToJpeg(await fixture(name));
      hashes.set(name, await perceptualHash(upright.data));
    }

    const nearDupe = phashDistance(
      hashes.get('04-garden.jpg') as string,
      hashes.get('05-garden-near-duplicate.jpg') as string,
    ) as number;
    expect(nearDupe).toBeLessThan(DUPE_HAMMING_THRESHOLD);

    // Every other pair is a different photograph and must stay apart.
    const dupePair = new Set(['04-garden.jpg', '05-garden-near-duplicate.jpg']);
    for (let i = 0; i < names.length; i += 1) {
      for (let j = i + 1; j < names.length; j += 1) {
        const a = names[i] as string;
        const b = names[j] as string;
        if (dupePair.has(a) && dupePair.has(b)) continue;
        const d = phashDistance(hashes.get(a) as string, hashes.get(b) as string) as number;
        expect(d, `${a} vs ${b}`).toBeGreaterThan(DUPE_HAMMING_THRESHOLD);
      }
    }
  });

  it('is unmoved by a hash it cannot read', () => {
    expect(phashDistance('short', '0'.repeat(64))).toBeUndefined();
    expect(looksLikeSameMoment('short', '0'.repeat(64))).toBe(false);
  });
});

describe('grouping near duplicates', () => {
  const a = '0'.repeat(64);
  const oneBitOff = `1${'0'.repeat(63)}`;
  const twoBitsOff = `11${'0'.repeat(62)}`;
  const faraway = '1'.repeat(64);

  it('groups a burst and leaves single photos alone', () => {
    const groups = groupNearDuplicates([
      { id: 'p1', phash: a, qualityScore: 0.4 },
      { id: 'p2', phash: oneBitOff, qualityScore: 0.9 },
      { id: 'p3', phash: faraway, qualityScore: 0.8 },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.memberIds).toEqual(['p1', 'p2']);
    // The sharpest frame is the one the family sees on the card.
    expect(groups[0]?.representativeId).toBe('p2');
  });

  it('follows a drifting burst by single link', () => {
    const groups = groupNearDuplicates(
      [
        { id: 'p1', phash: a },
        { id: 'p2', phash: oneBitOff },
        { id: 'p3', phash: twoBitsOff },
      ],
      1,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.memberIds).toEqual(['p1', 'p2', 'p3']);
  });

  it('ignores photos with no hash instead of grouping them together', () => {
    expect(
      groupNearDuplicates([
        { id: 'p1', phash: null },
        { id: 'p2', phash: undefined },
      ]),
    ).toEqual([]);
  });

  it('breaks representative ties on id, so the card never wanders', () => {
    expect(
      pickRepresentative([
        { id: 'b', phash: a, qualityScore: 0.5 },
        { id: 'a', phash: a, qualityScore: 0.5 },
      ]),
    ).toBe('a');
  });
});

describe('quality scoring', () => {
  it('ranks the blurred fixture below every sharp one, by a wide margin', async () => {
    const blurry = await measureQuality(await fixture('06-blurry.jpg'));
    const sharpOnes = await Promise.all(
      ['01-portrait.jpg', '02-beach.jpg', '03-wedding.jpg', '04-garden.jpg'].map(async (n) =>
        measureQuality(await fixture(n)),
      ),
    );

    for (const measurement of sharpOnes) {
      expect(measurement.blurScore).toBeGreaterThan(blurry.blurScore);
      expect(measurement.blurScore).toBeGreaterThan(BLURRY_SCORE_THRESHOLD);
      expect(isBlurry(measurement.blurScore)).toBe(false);
    }
    expect(isBlurry(blurry.blurScore)).toBe(true);
    expect(blurry.blurScore).toBeLessThan(0.1);
  });

  it('scores sharpness on a soft curve, with no cliff edge', () => {
    expect(sharpnessScore(0)).toBe(0);
    expect(sharpnessScore(60)).toBeCloseTo(0.5, 5);
    expect(sharpnessScore(6000)).toBeGreaterThan(0.98);
    expect(sharpnessScore(120)).toBeGreaterThan(sharpnessScore(60));
  });

  it('marks a mostly-blown-out frame down without discarding it', () => {
    const size = 64;
    const blown = new Uint8Array(size * size).fill(255);
    // A little structure so it is not pure white, which has no edges at all.
    for (let i = 0; i < blown.length; i += 7) blown[i] = 0;
    const measurement = measureQualityFromGray(blown, size, size);
    expect(measurement.clippedFraction).toBeGreaterThan(0.9);
    expect(measurement.qualityScore).toBeLessThan(measurement.blurScore);
    expect(measurement.qualityScore).toBeGreaterThan(0);
  });

  it('leaves ordinary contrast alone', async () => {
    const measurement = await measureQuality(await fixture('02-beach.jpg'));
    expect(measurement.clippedFraction).toBeLessThan(0.15);
    expect(measurement.qualityScore).toBe(measurement.blurScore);
  });
});

describe('processPhoto', () => {
  it('returns everything the database row needs, in one pass', async () => {
    const processed = await processPhoto(await fixture('04-garden.jpg'));
    expect(processed.sourceFormat).toBe('jpeg');
    expect(processed.width).toBe(640);
    expect(processed.height).toBe(480);
    expect(isValidPhash(processed.phash)).toBe(true);
    expect(processed.quality.qualityScore).toBeGreaterThan(0);
    expect(processed.variants).toHaveLength(3);
  });

  it('refuses a file that is not a photo, in words a person could read', async () => {
    await expect(processPhoto(await fixture('09-not-a-photo.jpg'))).rejects.toThrow(
      UnreadableMediaError,
    );
    await expect(processPhoto(await fixture('09-not-a-photo.jpg'))).rejects.toThrow(
      /could not open this file as a photo/i,
    );
  });

  it('refuses an empty file without a stack trace about buffers', async () => {
    await expect(processPhoto(Buffer.alloc(0))).rejects.toThrow(/empty/i);
  });
});

describe('mime handling', () => {
  it('recognises what a browser sends for a HEIC', () => {
    expect(normalizeUploadMime('', 'IMG_0421.HEIC')).toBe('image/heic');
    expect(normalizeUploadMime('application/octet-stream', 'IMG_0421.heic')).toBe('image/heic');
    expect(normalizeUploadMime('image/heic-sequence', 'x.heic')).toBe('image/heic');
    expect(normalizeUploadMime('image/jpeg', 'x.jpg')).toBe('image/jpeg');
    expect(normalizeUploadMime('video/quicktime', 'clip.MOV')).toBe('video/quicktime');
    expect(normalizeUploadMime(undefined, 'notes.txt')).toBe('application/octet-stream');
  });

  it('sorts images from videos from everything else', () => {
    expect(isImageMime('image/heic')).toBe(true);
    expect(isVideoMime('video/mp4')).toBe(true);
    expect(isImageMime('video/mp4')).toBe(false);
    expect(isVideoMime(null)).toBe(false);
  });

  it('chooses the stored extension itself, never trusting the filename', () => {
    expect(extensionForMime('image/jpeg')).toBe('jpg');
    expect(extensionForMime('IMAGE/HEIC')).toBe('heic');
    expect(extensionForMime('application/x-msdownload')).toBe('bin');
  });
});
