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
};

/**
 * 6 fixtures:
 *  - 4 distinct scenes
 *  - 1 near-duplicate of the "garden" scene (same pixels, tiny brightness delta)
 *    so phash dedupe has a true positive to find
 *  - 1 heavily blurred photo so blur scoring has a true positive to flag
 */
export const FIXTURE_SPECS: Spec[] = [
  { file: '01-portrait.jpg', bg: { r: 178, g: 62, b: 54 }, label: 'PORTRAIT 1975' },
  { file: '02-beach.jpg', bg: { r: 46, g: 106, b: 168 }, label: 'BEACH 1988' },
  { file: '03-wedding.jpg', bg: { r: 58, g: 138, b: 96 }, label: 'WEDDING 1962' },
  { file: '04-garden.jpg', bg: { r: 202, g: 152, b: 48 }, label: 'GARDEN 2004' },
  {
    file: '05-garden-near-duplicate.jpg',
    bg: { r: 202, g: 152, b: 48 },
    label: 'GARDEN 2004',
    brightness: 1.03,
  },
  { file: '06-blurry.jpg', bg: { r: 122, g: 78, b: 168 }, label: 'BLURRY 1999', blur: 14 },
];

/**
 * Structured overlay: bands + a framed box + a text label. The bands give phash
 * something real to hash (a flat colour field hashes to almost nothing).
 */
function overlaySvg(label: string, bg: Spec['bg']): Buffer {
  const dark = `rgb(${Math.round(bg.r * 0.55)},${Math.round(bg.g * 0.55)},${Math.round(bg.b * 0.55)})`;
  const light = `rgb(${Math.min(255, Math.round(bg.r * 1.35))},${Math.min(255, Math.round(bg.g * 1.35))},${Math.min(255, Math.round(bg.b * 1.35))})`;
  const bands = Array.from({ length: 8 }, (_, i) => {
    const y = 40 + i * 52;
    const w = 120 + ((i * 97) % 380);
    const fill = i % 2 === 0 ? dark : light;
    return `<rect x="${30 + ((i * 61) % 200)}" y="${y}" width="${w}" height="26" fill="${fill}" opacity="0.85"/>`;
  }).join('');
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">` +
      bands +
      `<circle cx="${WIDTH - 120}" cy="120" r="70" fill="${light}" opacity="0.9"/>` +
      `<rect x="24" y="${HEIGHT - 96}" width="${WIDTH - 48}" height="64" rx="8" fill="#ffffff" opacity="0.92"/>` +
      `<text x="${WIDTH / 2}" y="${HEIGHT - 52}" font-family="sans-serif" font-size="30" font-weight="bold" text-anchor="middle" fill="#1a1a1a">${label}</text>` +
      `</svg>`,
    'utf8',
  );
}

async function renderOne(spec: Spec): Promise<Buffer> {
  let img = sharp({
    create: { width: WIDTH, height: HEIGHT, channels: 3, background: spec.bg },
  }).composite([{ input: overlaySvg(spec.label, spec.bg), top: 0, left: 0 }]);

  if (spec.brightness !== undefined) img = img.linear(spec.brightness, 0);
  if (spec.blur !== undefined) img = img.blur(spec.blur);

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
  return written;
}

export async function fixturesArePresent(outDir: string = FIXTURE_PHOTO_DIR): Promise<boolean> {
  try {
    const entries = new Set(await readdir(outDir));
    return FIXTURE_SPECS.every((s) => entries.has(s.file));
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
