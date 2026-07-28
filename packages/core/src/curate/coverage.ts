/**
 * Where the story has holes.
 *
 * A slideshow made only of the last five years is a common, quiet failure: the
 * phone era is easy to collect and the shoebox era is not, so the woman on
 * screen is eighty for four minutes. The fix is not more work for the organiser
 * — it is a nudge that turns into a bounded ask of someone else: "No photos
 * from her twenties yet — someone may have a shoebox. Ask them?"
 *
 * This is a heuristic over decades and nothing more. The AI coverage pass in a
 * later phase can say something cleverer; it will not need to say something
 * different.
 */
import { UNKNOWN_ERA } from './grid';

export type CoverageGap = {
  /** '1950s' */
  era: string;
  startYear: number;
  /** Their age across that decade, when we know when they were born. */
  ageRange?: { from: number; to: number };
  /** The nudge, in the words the screen uses. */
  message: string;
};

export type CoverageInput = {
  birthYear?: number | null;
  deathYear?: number | null;
  /** Decade label → how many photos we have. */
  countsByEra: Map<string, number>;
  /** Used when there is no birth year: the earliest decade we do have. */
  now?: number;
};

const DECADE = 10;

function decadesBetween(fromYear: number, toYear: number): number[] {
  const first = Math.floor(fromYear / DECADE) * DECADE;
  const last = Math.floor(toYear / DECADE) * DECADE;
  const out: number[] = [];
  for (let year = first; year <= last; year += DECADE) out.push(year);
  return out;
}

/**
 * Only the decades of an adult life we plausibly have photographs of, and only
 * the ones between decades we *do* have — a gap is a hole in a run, not the
 * absence of a beginning. Otherwise every family would be told, on day one,
 * that they are missing eight decades.
 */
export function findCoverageGaps(input: CoverageInput): CoverageGap[] {
  const { countsByEra } = input;
  const known = [...countsByEra.entries()]
    .filter(([era, count]) => era !== UNKNOWN_ERA && count > 0)
    .map(([era]) => Number.parseInt(era, 10))
    .filter((year) => Number.isFinite(year))
    .sort((a, b) => a - b);

  if (known.length === 0) return [];

  const earliest = known[0] as number;
  const latest = known[known.length - 1] as number;

  // Bound the sweep by the life itself when we know it, so we never suggest a
  // decade before they were born or after they died. It starts at the earliest
  // decade we already have — a family on day one should not be told they are
  // missing the 1940s, only that a run has a hole in it — and it runs to the
  // end of the life, because the last years are a gap worth naming.
  const lifeStart = input.birthYear ? Math.floor(input.birthYear / DECADE) * DECADE : earliest;
  const lifeEnd = input.deathYear ? Math.floor(input.deathYear / DECADE) * DECADE : latest;
  const from = Math.max(lifeStart, earliest);
  const to = Math.max(from, lifeEnd);

  const gaps: CoverageGap[] = [];
  for (const startYear of decadesBetween(from, to)) {
    const era = `${startYear}s`;
    if ((countsByEra.get(era) ?? 0) > 0) continue;
    const ageRange = input.birthYear
      ? { from: Math.max(0, startYear - input.birthYear), to: Math.max(0, startYear + 9 - input.birthYear) }
      : undefined;
    gaps.push({
      era,
      startYear,
      ...(ageRange ? { ageRange } : {}),
      message: gapMessage(era, ageRange),
    });
  }
  return gaps;
}

/**
 * Warm, specific, and ending in a question the organiser can hand to someone
 * else. Ages are given as a decade of life ("her thirties") because that is how
 * a family would ask an aunt.
 */
const AGE_DECADE_WORD: Record<number, string> = {
  10: 'teens',
  20: 'twenties',
  30: 'thirties',
  40: 'forties',
  50: 'fifties',
  60: 'sixties',
  70: 'seventies',
  80: 'eighties',
  90: 'nineties',
};

export function gapMessage(era: string, ageRange?: { from: number; to: number }): string {
  if (ageRange) {
    const decade = Math.floor(ageRange.from / 10) * 10;
    const subject = decade < 10 ? 'their childhood' : `their ${AGE_DECADE_WORD[decade] ?? era}`;
    if (decade < 10 || AGE_DECADE_WORD[decade]) {
      return `No photos from ${subject} yet — someone may have a shoebox. Ask them?`;
    }
  }
  return `No photos from the ${era} yet — someone may have a shoebox. Ask them?`;
}

/** The single nudge worth showing. More than one at a time is a to-do list. */
export function primaryGap(gaps: readonly CoverageGap[]): CoverageGap | undefined {
  // Earliest first: the oldest photographs are the ones most likely to be in
  // somebody else's attic, and the hardest to find later.
  return [...gaps].sort((a, b) => a.startYear - b.startYear)[0];
}
