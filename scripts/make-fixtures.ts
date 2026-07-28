/**
 * Generates the deterministic photo fixture set used by tests and by local
 * demos of the curation pipeline (dedupe / blur detection).
 *
 * Everything here is offline: images are synthesised with sharp, no network.
 *
 * Run directly:  pnpm fixtures
 * Auto-run:      vitest global setup, when fixtures/photos is missing/incomplete
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_PHOTO_DIR = path.resolve(here, '..', 'fixtures', 'photos');

const WIDTH = 640;
const HEIGHT = 480;

type Spec = {
  file: string;
  /** Background colour, also the visual identity of the fixture. */
  bg: { r: number; g: number; b: number };
  label: string;
  /** Gaussian blur sigma — used to produce the intentionally unusable photo. */
  blur?: number;
  /** Linear brightness multiplier — used to produce the near-duplicate. */
  brightness?: number;
  /** Reframing, in pixels: the hand moved between two shots of one moment. */
  nudgePx?: number;
  /**
   * EXIF orientation tag written into the file *without* rotating the pixels —
   * exactly what a phone does when it is held sideways. Ingest has to honour it,
   * or half a family's photos arrive on their side.
   */
  orientation?: number;
  /** Encode as HEIF/HEIC rather than JPEG, like a modern iPhone. */
  heic?: boolean;
  /**
   * Seed for the scene layout. Two fixtures sharing a seed are two shots of the
   * same moment (what dedupe must catch); different seeds are different
   * photographs (what dedupe must leave alone). Colour alone is not enough —
   * perceptual hashing works on greyscale structure.
   */
  scene: number;
};

/**
 * 8 fixtures:
 *  - 4 distinct scenes
 *  - 1 near-duplicate of the "garden" scene (same pixels, tiny brightness delta)
 *    so phash dedupe has a true positive to find
 *  - 1 heavily blurred photo so blur scoring has a true positive to flag
 *  - 1 sideways photo carrying EXIF orientation 6, so auto-rotate has a subject
 *  - 1 HEIC, so the HEIC→JPEG path is exercised rather than assumed
 */
export const FIXTURE_SPECS: Spec[] = [
  { file: '01-portrait.jpg', bg: { r: 178, g: 62, b: 54 }, label: 'PORTRAIT 1975', scene: 11 },
  { file: '02-beach.jpg', bg: { r: 46, g: 106, b: 168 }, label: 'BEACH 1988', scene: 27 },
  { file: '03-wedding.jpg', bg: { r: 58, g: 138, b: 96 }, label: 'WEDDING 1962', scene: 43 },
  { file: '04-garden.jpg', bg: { r: 202, g: 152, b: 48 }, label: 'GARDEN 2004', scene: 61 },
  {
    // The same moment, one second later: same scene seed, a touch brighter.
    file: '05-garden-near-duplicate.jpg',
    bg: { r: 202, g: 152, b: 48 },
    label: 'GARDEN 2004',
    scene: 61,
    brightness: 1.03,
    nudgePx: 10,
  },
  { file: '06-blurry.jpg', bg: { r: 122, g: 78, b: 168 }, label: 'BLURRY 1999', scene: 79, blur: 9 },
  {
    file: '07-sideways.jpg',
    bg: { r: 96, g: 104, b: 132 },
    label: 'SIDEWAYS 1981',
    scene: 97,
    orientation: 6,
  },
  {
    file: '08-phone.heic',
    bg: { r: 66, g: 132, b: 118 },
    label: 'PHONE 2019',
    scene: 113,
    heic: true,
  },
];

/**
 * A file that claims to be a photo and is not. Ingest must park it politely
 * instead of taking the worker down, so the unhappy path gets a fixture too.
 */
export const POISON_FIXTURE = { file: '09-not-a-photo.jpg', bytes: 'this is not an image at all\n' };

/** Tiny deterministic PRNG (mulberry32). Same seed, same picture, every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A scene: a dozen shapes laid out from the seed, in tones derived from the
 * background colour, plus a caption bar.
 *
 * The shapes are the point. Perceptual hashing sees greyscale structure, and
 * blur scoring sees edges, so a fixture set that varies only in colour would
 * make every photo a duplicate of every other one and nothing would be
 * measurably sharp. Different seed = genuinely different photograph.
 */
function sceneSvg(label: string, bg: Spec['bg'], seed: number): Buffer {
  const tone = (f: number) =>
    `rgb(${Math.min(255, Math.round(bg.r * f))},${Math.min(255, Math.round(bg.g * f))},${Math.min(255, Math.round(bg.b * f))})`;
  const next = rng(seed);
  const shapes: string[] = [];

  for (let i = 0; i < 14; i += 1) {
    const fill = tone(0.35 + next() * 1.25);
    const x = Math.round(next() * (WIDTH - 60));
    const y = Math.round(next() * (HEIGHT - 140));
    const w = Math.round(40 + next() * 260);
    const h = Math.round(30 + next() * 190);
    shapes.push(
      next() < 0.45
        ? `<circle cx="${x + w / 2}" cy="${y + h / 2}" r="${Math.round(Math.min(w, h) / 2)}" fill="${fill}" opacity="0.9"/>`
        : `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" opacity="0.9"/>`,
    );
  }

  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">` +
      shapes.join('') +
      `<rect x="24" y="${HEIGHT - 96}" width="${WIDTH - 48}" height="64" rx="8" fill="#ffffff" opacity="0.92"/>` +
      `<text x="${WIDTH / 2}" y="${HEIGHT - 52}" font-family="sans-serif" font-size="30" font-weight="bold" text-anchor="middle" fill="#1a1a1a">${label}</text>` +
      `</svg>`,
    'utf8',
  );
}

async function renderOne(spec: Spec): Promise<Buffer> {
  // Flattened to pixels first, because sharp orders its pipeline internally:
  // a blur asked for in the same chain lands *under* the composite, which is
  // how the Phase 0 "blurry" fixture ended up perfectly sharp.
  let pixels = await sharp({
    create: { width: WIDTH, height: HEIGHT, channels: 3, background: spec.bg },
  })
    .composite([{ input: sceneSvg(spec.label, spec.bg, spec.scene), top: 0, left: 0 }])
    .png()
    .toBuffer();

  if (spec.blur !== undefined) {
    pixels = await sharp(pixels).blur(spec.blur).png().toBuffer();
  }

  if (spec.nudgePx !== undefined) {
    const n = spec.nudgePx;
    pixels = await sharp(pixels)
      .extract({ left: n, top: n, width: WIDTH - 2 * n, height: HEIGHT - 2 * n })
      .resize(WIDTH, HEIGHT)
      .png()
      .toBuffer();
  }

  let img = sharp(pixels);
  if (spec.brightness !== undefined) img = img.linear(spec.brightness, 0);

  // HEIF here is AV1-coded: the HEVC encoder is not in sharp's prebuilt libvips,
  // and for our purposes ("a container the browser cannot show, which we must
  // normalise") the coding matters less than the coding format.
  if (spec.heic) return img.heif({ compression: 'av1', quality: 60 }).toBuffer();

  if (spec.orientation !== undefined) img = img.withMetadata({ orientation: spec.orientation });

  // mozjpeg + modest quality keeps every fixture comfortably under 50 KB.
  return img.jpeg({ quality: 72, mozjpeg: true }).toBuffer();
}

export async function makeFixtures(outDir: string = FIXTURE_PHOTO_DIR): Promise<string[]> {
  await mkdir(outDir, { recursive: true });
  const written: string[] = [];
  for (const spec of FIXTURE_SPECS) {
    const target = path.join(outDir, spec.file);
    await writeFile(target, await renderOne(spec));
    written.push(target);
  }
  const poison = path.join(outDir, POISON_FIXTURE.file);
  await writeFile(poison, POISON_FIXTURE.bytes, 'utf8');
  written.push(poison);
  return written;
}

export async function fixturesArePresent(outDir: string = FIXTURE_PHOTO_DIR): Promise<boolean> {
  try {
    const entries = new Set(await readdir(outDir));
    return (
      FIXTURE_SPECS.every((s) => entries.has(s.file)) && entries.has(POISON_FIXTURE.file)
    );
  } catch {
    return false;
  }
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const files = await makeFixtures();
  // eslint-disable-next-line no-console
  console.log(`Wrote ${files.length} photo fixtures to ${FIXTURE_PHOTO_DIR}`);
}
