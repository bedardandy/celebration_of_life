/**
 * Turning whatever arrived into something we can show.
 *
 * What arrives is: HEIC from an iPhone, a 12-megapixel JPEG held sideways, a
 * photograph of a photograph taken on a kitchen table, a screenshot, and
 * occasionally a file that is not an image at all. What has to come out the far
 * side is one predictable thing — an upright JPEG in three sizes, with a date
 * if the file knew one, a fingerprint for duplicate grouping, and a quality
 * score — or a clear, non-fatal "we could not open this".
 *
 * The original bytes are never modified. Everything here is derived, so if we
 * get the processing wrong we can redo it from what the family sent.
 */
import sharp from 'sharp';
import type { Metadata, Sharp } from 'sharp';
import { eraGuess, readExif, type ExifFacts } from './exif';
import { perceptualHash } from './phash';
import { measureQuality, type QualityMeasurement } from './quality';

/** Longest-edge targets. thumb320 for the grid, web1600 for review, render2400 for video. */
export const VARIANT_EDGES = {
  thumb320: 320,
  web1600: 1600,
  render2400: 2400,
} as const;

export type VariantName = keyof typeof VARIANT_EDGES;

export const VARIANT_NAMES = Object.keys(VARIANT_EDGES) as VariantName[];

/** Quality 82: the knee of the curve for photographs. Above it, bytes without eyes. */
export const JPEG_QUALITY = 82;

export const DERIVED_MIME = 'image/jpeg';

/** Refuse absurd inputs rather than letting libvips chew through a decompression bomb. */
export const MAX_INPUT_PIXELS = 200_000_000;

export class UnreadableMediaError extends Error {
  /** What sharp actually said, kept for the log and never shown to a family. */
  readonly detail?: unknown;

  constructor(message: string, detail?: unknown) {
    super(message);
    this.name = 'UnreadableMediaError';
    this.detail = detail;
  }
}

export type RenderedVariant = {
  name: VariantName;
  data: Buffer;
  width: number;
  height: number;
  byteSize: number;
  mime: string;
};

export type ProcessedPhoto = {
  /** Dimensions after EXIF rotation — what a person actually sees. */
  width: number;
  height: number;
  /** Format we were handed, e.g. 'jpeg', 'heif', 'png'. */
  sourceFormat: string;
  exif: ExifFacts;
  capturedAt?: number;
  era?: string;
  phash: string;
  quality: QualityMeasurement;
  variants: RenderedVariant[];
};

function openImage(input: Buffer): Sharp {
  // failOn 'none' on purpose: a truncated JPEG from a 2009 phone still shows a
  // face, and a family should not lose it to strictness. Genuinely unreadable
  // files fail at metadata/decode time, which is where we handle them.
  return sharp(input, { failOn: 'none', limitInputPixels: MAX_INPUT_PIXELS });
}

/**
 * One upright JPEG. `.rotate()` with no argument applies the EXIF orientation
 * and then drops the tag, which is what stops a photo being rotated twice by a
 * viewer that also honours it.
 */
export async function normalizeToJpeg(
  input: Buffer,
  options: { maxEdge?: number; quality?: number } = {},
): Promise<{ data: Buffer; width: number; height: number }> {
  const pipeline = openImage(input).rotate();
  if (options.maxEdge) {
    pipeline.resize({
      width: options.maxEdge,
      height: options.maxEdge,
      fit: 'inside',
      withoutEnlargement: true,
    });
  }
  const { data, info } = await pipeline
    .jpeg({ quality: options.quality ?? JPEG_QUALITY, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

export async function renderVariant(input: Buffer, name: VariantName): Promise<RenderedVariant> {
  const { data, width, height } = await normalizeToJpeg(input, { maxEdge: VARIANT_EDGES[name] });
  return { name, data, width, height, byteSize: data.byteLength, mime: DERIVED_MIME };
}

/** True for anything we should try to open as a still image. */
export function isImageMime(mime: string | null | undefined): boolean {
  return typeof mime === 'string' && mime.toLowerCase().startsWith('image/');
}

export function isVideoMime(mime: string | null | undefined): boolean {
  return typeof mime === 'string' && mime.toLowerCase().startsWith('video/');
}

/**
 * The whole still-image pipeline, in one call, with no side effects: hand it
 * bytes, get back everything the database and the blob store need. Keeping it
 * pure is what lets the worker handler be about retries and rows instead of
 * about pixels.
 */
export async function processPhoto(
  input: Buffer,
  options: { now?: number; variants?: readonly VariantName[] } = {},
): Promise<ProcessedPhoto> {
  if (!Buffer.isBuffer(input) || input.byteLength === 0) {
    throw new UnreadableMediaError('The file was empty.');
  }

  let metadata: Metadata;
  try {
    metadata = await openImage(input).metadata();
  } catch (err) {
    throw new UnreadableMediaError('We could not open this file as a photo.', err);
  }
  if (!metadata.width || !metadata.height) {
    throw new UnreadableMediaError('We could not open this file as a photo.');
  }

  // Everything downstream (hash, quality, variants) works from one upright
  // full-size JPEG, so orientation and colour handling happen exactly once.
  let upright: { data: Buffer; width: number; height: number };
  try {
    upright = await normalizeToJpeg(input);
  } catch (err) {
    throw new UnreadableMediaError('We could not open this file as a photo.', err);
  }

  const exif = await readExif(input, options.now);
  const [phash, quality] = await Promise.all([
    perceptualHash(upright.data),
    measureQuality(upright.data),
  ]);

  const wanted = options.variants ?? VARIANT_NAMES;
  const variants: RenderedVariant[] = [];
  for (const name of wanted) {
    variants.push(await renderVariant(upright.data, name));
  }

  const era = eraGuess(exif.takenAt);
  return {
    width: upright.width,
    height: upright.height,
    sourceFormat: metadata.format ?? 'unknown',
    exif,
    ...(exif.takenAt !== undefined ? { capturedAt: exif.takenAt } : {}),
    ...(era !== undefined ? { era } : {}),
    phash,
    quality,
    variants,
  };
}

/**
 * File extension for a stored original. Only ever from a fixed table: the
 * uploaded filename is untrusted, and blob keys are ours to choose.
 */
export function extensionForMime(mime: string): string {
  const table: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/avif': 'avif',
    'image/tiff': 'tiff',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'image/bmp': 'bmp',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/x-m4v': 'm4v',
    'video/webm': 'webm',
    'video/3gpp': '3gp',
  };
  return table[mime.toLowerCase()] ?? 'bin';
}

/**
 * What a browser calls a HEIC varies ('', 'application/octet-stream',
 * 'image/heic-sequence'), so the extension is worth a look before we decide a
 * file is not a photo.
 */
export function normalizeUploadMime(mime: string | undefined, filename?: string): string {
  const claimed = (mime ?? '').trim().toLowerCase();
  const ext = (filename ?? '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const byExtension: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    heic: 'image/heic',
    heif: 'image/heif',
    bmp: 'image/bmp',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    m4v: 'video/x-m4v',
    webm: 'video/webm',
    '3gp': 'video/3gpp',
  };
  if (claimed.startsWith('image/') || claimed.startsWith('video/')) {
    return claimed === 'image/heic-sequence' ? 'image/heic' : claimed;
  }
  if (ext && byExtension[ext]) return byExtension[ext] as string;
  return claimed || 'application/octet-stream';
}
