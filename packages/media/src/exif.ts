/**
 * What the file itself remembers.
 *
 * A photo's EXIF block is often the only date anybody has: the cousin who
 * uploads forty pictures will not type a year for any of them, and "when was
 * this?" is the question the curation grid is built around. So we read the
 * capture time where it exists, guess a decade from it, and — importantly —
 * treat a missing or nonsensical date as ordinary rather than as an error. A
 * scan of a 1962 wedding print carries the date it was scanned, if it carries
 * one at all.
 */
import exifr from 'exifr';

/** Nothing before photography, nothing from a camera with a flat clock battery. */
const EARLIEST_PLAUSIBLE = Date.UTC(1826, 0, 1);

export type ExifFacts = {
  /** Epoch ms, or undefined when the file does not say. */
  takenAt?: number;
  /** EXIF orientation tag (1–8) when present; the pixels are not moved by us here. */
  orientation?: number;
};

function toEpochMs(value: unknown): number | undefined {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    // EXIF writes "2004:07:19 14:03:11"; Date cannot read that as-is.
    const normalized = value.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(' ', 'T');
    const ms = Date.parse(normalized);
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
}

/**
 * A date is only useful if it could plausibly belong to a life. Cameras with a
 * dead clock battery report 1970 or 1980-01-01; phones occasionally report a
 * date in the future. Rather than filing a photo under "the 1970s" on that
 * evidence, we say we do not know.
 */
export function isPlausibleCaptureTime(ms: number, now: number = Date.now()): boolean {
  if (!Number.isFinite(ms)) return false;
  // A day of slack: clocks drift, and time zones are not always what EXIF says.
  return ms >= EARLIEST_PLAUSIBLE && ms <= now + 24 * 60 * 60 * 1000;
}

/**
 * Raw EXIF tag numbers, used as a fallback.
 *
 * exifr resolves tag numbers to names only for the IFD it expects each tag to
 * live in, and real-world files put them wherever the writing software felt
 * like. Falling back to the number costs three lines and rescues the date on
 * files that would otherwise land in "when was this?".
 */
const TAG = {
  ModifyDate: 306,
  Orientation: 274,
  DateTimeOriginal: 36867,
  CreateDate: 36868,
} as const;

/** Never throws. A photo with unreadable metadata is still a photo. */
export async function readExif(input: Buffer, now: number = Date.now()): Promise<ExifFacts> {
  try {
    const parsed = (await exifr.parse(input, {
      tiff: true,
      exif: true,
      // Values as the file wrote them: "Rotate 90 CW" is friendlier to read and
      // useless to compute with.
      translateValues: false,
    })) as Record<string, unknown> | undefined;
    if (!parsed) return {};

    const candidate =
      toEpochMs(parsed['DateTimeOriginal'] ?? parsed[TAG.DateTimeOriginal]) ??
      toEpochMs(parsed['CreateDate'] ?? parsed[TAG.CreateDate]) ??
      toEpochMs(parsed['ModifyDate'] ?? parsed[TAG.ModifyDate]);

    const rawOrientation = parsed['Orientation'] ?? parsed[TAG.Orientation];
    const orientation = typeof rawOrientation === 'number' ? rawOrientation : undefined;

    return {
      ...(candidate !== undefined && isPlausibleCaptureTime(candidate, now)
        ? { takenAt: candidate }
        : {}),
      ...(orientation !== undefined && orientation >= 1 && orientation <= 8 ? { orientation } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * The decade a photo belongs to, as a label a person would say out loud.
 * Undefined when we have no date — the curation grid has a "when was this?"
 * group for exactly that, and it is not a failure state.
 */
export function eraGuess(takenAt: number | null | undefined): string | undefined {
  if (takenAt == null || !Number.isFinite(takenAt)) return undefined;
  const year = new Date(takenAt).getUTCFullYear();
  if (year < 1826 || year > 2200) return undefined;
  return `${Math.floor(year / 10) * 10}s`;
}

/** '1960s' → 1960. The inverse, for ordering era groups on the screen. */
export function eraStartYear(era: string): number | undefined {
  const match = /^(\d{4})s$/.exec(era);
  if (!match?.[1]) return undefined;
  return Number.parseInt(match[1], 10);
}
