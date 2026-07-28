/**
 * What the file is called.
 *
 * This matters more than it looks. The file gets copied to a USB stick, handed
 * to a funeral director, opened on a machine in a room full of people, and
 * sometimes read aloud down a telephone. "render_final_v2 (1).mp4" is a small
 * indignity at exactly the wrong moment.
 *
 * So: the person's name, what the video is, and nothing else —
 * "Ruth-Middleton-Celebration-of-Life-Service.mp4". ASCII, no spaces, no
 * punctuation a FAT32 stick or a Windows machine will refuse.
 */
import type { CutName, RenderPreset } from '@col/schemas';

/** Characters Windows, macOS and FAT32 all agree are fine in a file name. */
const UNSAFE = /[^A-Za-z0-9._-]+/g;

/**
 * Fold a name down to something safe, keeping it readable.
 *
 * Accented characters are decomposed and stripped rather than replaced with
 * underscores, because "Bjorn" is a name and "Bj_rn" is a bug report. A name
 * with nothing ASCII in it at all — which is a real thing, not an edge case —
 * falls back to the caller's default rather than producing an empty string.
 */
/**
 * Latin letters that are not an accented ASCII letter underneath, so
 * decomposition alone leaves them behind. Not an exhaustive transliteration —
 * just the ones that turn up in the names of people who die in English-speaking
 * countries, which is exactly the set worth getting right.
 */
const LATIN_EQUIVALENTS: [RegExp, string][] = [
  [/ø/g, 'o'],
  [/Ø/g, 'O'],
  [/æ/g, 'ae'],
  [/Æ/g, 'AE'],
  [/œ/g, 'oe'],
  [/Œ/g, 'OE'],
  [/ß/g, 'ss'],
  [/ð/g, 'd'],
  [/Ð/g, 'D'],
  [/þ/g, 'th'],
  [/Þ/g, 'Th'],
  [/ł/g, 'l'],
  [/Ł/g, 'L'],
  [/đ/g, 'd'],
  [/Đ/g, 'D'],
];

export function sanitizeFilenamePart(input: string, fallback = 'Celebration-of-Life'): string {
  const folded = LATIN_EQUIVALENTS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    input,
  )
    .normalize('NFKD')
    // Combining marks left behind by the decomposition above.
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['‘’`]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(UNSAFE, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return folded.length > 0 ? folded.slice(0, 80) : fallback;
}

export const CUT_LABELS: Record<CutName, string> = {
  service: 'Service',
  family: 'Family',
};

export const PRESET_LABELS: Record<RenderPreset, string> = {
  draft360: 'Quick-preview',
  final1080: '',
  backup720: '720p-backup',
};

export type DeliverableNameParts = {
  decedentName: string;
  cut: CutName;
  preset: RenderPreset;
  extension?: string;
};

/**
 * The name a family downloads.
 *
 * The final 1080p file carries no quality marker at all, because it is simply
 * *the* video; the draft and the backup say what they are, so nobody plays the
 * wrong one at a funeral.
 */
export function deliverableFilename(parts: DeliverableNameParts): string {
  const name = sanitizeFilenamePart(parts.decedentName, 'Celebration-of-Life');
  const segments = [name, 'Celebration-of-Life', CUT_LABELS[parts.cut]];
  const preset = PRESET_LABELS[parts.preset];
  if (preset) segments.push(preset);
  return `${segments.join('-')}.${parts.extension ?? 'mp4'}`;
}

/** "Ruth-Middleton-Celebration-of-Life-Service" — no extension, for a heading. */
export function deliverableTitle(parts: Omit<DeliverableNameParts, 'extension'>): string {
  return deliverableFilename(parts).replace(/\.mp4$/, '');
}
