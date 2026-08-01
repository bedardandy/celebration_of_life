/**
 * The read-aloud timer's arithmetic.
 *
 * Every funeral-planning guide says the same two things: practise it out loud,
 * and add twenty to thirty per cent to whatever the stopwatch said, because
 * emotion slows delivery — people stop, they breathe, they wait for a room to
 * settle. We take the middle of that band, and we say the adjusted number out
 * loud rather than hiding it, because "you ran to four minutes ten, so plan for
 * about five fifteen" is a fact somebody can act on the night before.
 *
 * Pure functions, no clock. The timer component owns the clock; this owns the
 * maths, so it can be tested and so both halves cannot drift apart.
 */
import { PAUSE_MARKER } from '@col/schemas';

/** Unhurried speech at a lectern. The eulogy screens quote this number. */
export const SPOKEN_WORDS_PER_MINUTE = 130;

/**
 * Emotion allowance. The research band is 20–30%; 25% is the middle of it, and
 * a quarter is a number a tired person can check in their head.
 */
export const EMOTION_ALLOWANCE = 1.25;

/** How long a held beat lasts, when a `[pause]` marker asks for one. */
export const PAUSE_SECONDS = 2.5;

export function isPauseMarker(paragraph: string): boolean {
  return paragraph.trim().toLowerCase() === PAUSE_MARKER;
}

/**
 * Words a person will actually say out loud. Pause markers are stage
 * directions, not words, and punctuation on its own is not a word either.
 */
export function countSpokenWords(text: string): number {
  return text
    .split(/\n+/)
    .filter((line) => !isPauseMarker(line))
    .join(' ')
    .replace(/\[pause\]/gi, ' ')
    .split(/\s+/)
    .filter((word) => /[a-z0-9]/i.test(word)).length;
}

/** Paragraphs, blank-line separated, pause markers kept as their own entries. */
export function paragraphsOf(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

/** Seconds this text would take at an unhurried reading pace. */
export function estimateReadSeconds(
  text: string,
  wordsPerMinute = SPOKEN_WORDS_PER_MINUTE,
): number {
  const words = countSpokenWords(text);
  const pauses = paragraphsOf(text).filter(isPauseMarker).length;
  return (words / wordsPerMinute) * 60 + pauses * PAUSE_SECONDS;
}

/** What to plan for on the day, given what the stopwatch said in the kitchen. */
export function withEmotionAllowance(seconds: number): number {
  return seconds * EMOTION_ALLOWANCE;
}

/** "4:10". Minutes and seconds, because that is how a stopwatch reads. */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${rest < 10 ? '0' : ''}${rest}`;
}

export type PacedParagraph = {
  index: number;
  text: string;
  pause: boolean;
  startSec: number;
  durationSec: number;
};

/**
 * Where the highlight should be at any moment. The timer walks this list rather
 * than scrolling by pixels, so a long paragraph is never skipped past and a
 * pause is visibly a pause.
 */
export function paceParagraphs(
  text: string,
  wordsPerMinute = SPOKEN_WORDS_PER_MINUTE,
): PacedParagraph[] {
  let cursor = 0;
  return paragraphsOf(text).map((paragraph, index) => {
    const pause = isPauseMarker(paragraph);
    const durationSec = pause ? PAUSE_SECONDS : (countSpokenWords(paragraph) / wordsPerMinute) * 60;
    const startSec = cursor;
    cursor += durationSec;
    return { index, text: paragraph, pause, startSec, durationSec };
  });
}

export type ReadAloudSummary = {
  /** What the stopwatch said. */
  elapsedLabel: string;
  /** What to plan for on the day. */
  plannedLabel: string;
  /** The two sentences, ready to put on screen. */
  line: string;
  /** How the read compares with what they aimed for. Never a telling-off. */
  verdict: string;
};

/**
 * The sentence the timer stops on.
 *
 * It never says "too long". A person who has just read their mother's eulogy
 * out loud to an empty room does not need a scold; they need the number and one
 * calm suggestion.
 */
export function readAloudSummary(elapsedSec: number, targetMinutes: number): ReadAloudSummary {
  const planned = withEmotionAllowance(elapsedSec);
  const elapsedLabel = formatClock(elapsedSec);
  const plannedLabel = formatClock(planned);
  const targetSec = targetMinutes * 60;
  const over = planned - targetSec;

  const verdict =
    over > 90
      ? `That is a few minutes past the ${targetMinutes} you were aiming for. ` +
        '“A little shorter” takes one story out and keeps the rest.'
      : over > 0
        ? `That is close to the ${targetMinutes} minutes you were aiming for. Near enough.`
        : `Comfortably inside the ${targetMinutes} minutes you were aiming for.`;

  return {
    elapsedLabel,
    plannedLabel,
    line: `Your read: ${elapsedLabel}. On the day, plan for about ${plannedLabel}.`,
    verdict,
  };
}

/** "about 5 minutes" — a length in words, for a card or a list. */
export function describeSpeechLength(text: string): string {
  const seconds = estimateReadSeconds(text);
  if (seconds < 45) return 'under a minute';
  const minutes = Math.round(seconds / 60);
  return `about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}
