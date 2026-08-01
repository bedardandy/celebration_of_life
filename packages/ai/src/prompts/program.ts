/**
 * The life sketch that goes inside a printed program.
 *
 * A hundred and fifty to two hundred and fifty words, on paper people will keep
 * in a drawer for thirty years. It is the obituary's kinder cousin: not a list
 * of survivors and dates, but a short account of a life that somebody could
 * read standing at the back of a room.
 *
 * The same rule as everywhere else in this product: every fact comes from what
 * the family has written down, and nothing is added because it would round the
 * paragraph off nicely.
 */

/** Task tag and fixture folder for program work: `fixtures/ai/program/`. */
export const PROGRAM_TASK = 'program';

export const LIFE_SKETCH_MIN_WORDS = 150;
export const LIFE_SKETCH_MAX_WORDS = 250;

export const LIFE_SKETCH_SYSTEM_PROMPT = [
  'You are drafting the short life sketch printed inside a funeral program.',
  '',
  `Between ${LIFE_SKETCH_MIN_WORDS} and ${LIFE_SKETCH_MAX_WORDS} words, in two or`,
  'three paragraphs. It is read by people who knew them and by people who did not,',
  'so it has to be clear without being cold.',
  '',
  'How to write it:',
  '- Plain past tense. Ordinary words. No euphemism for dying — "died" is the',
  '  word, unless the family have used another one, in which case use theirs.',
  '- Where they began, the shape of their working life, the people, and one or',
  '  two concrete things that were unmistakably them.',
  '- Names and dates exactly as given. If a year is not in the notes, do not',
  '  write a year.',
  '- No epitaph, no blessing, no promise about where they are now, unless the',
  '  family already wrote one.',
  '',
  'Use only what is in the notes. A shorter sketch that is entirely true is worth',
  'far more than a fuller one with a plausible sentence in it, because this is',
  'printed, handed out, and kept.',
].join('\n');

export type LifeSketchPromptInput = {
  subject: { fullName: string; knownAs?: string; birthYear?: number; deathYear?: number };
  chapters?: readonly { title: string; summary?: string }[];
  /** Approved anecdotes, in the family's words. Facts, not decoration. */
  anecdotes?: readonly string[];
  themes?: readonly string[];
  toneNotes?: string;
  /** Where and when the service is, if the family want it mentioned. */
  serviceLine?: string;
};

export function buildLifeSketchPrompt(input: LifeSketchPromptInput): string {
  const { subject } = input;
  const lines: string[] = [];
  const years =
    subject.birthYear && subject.deathYear
      ? `${subject.birthYear}–${subject.deathYear}`
      : subject.birthYear
        ? `born ${subject.birthYear}`
        : '';

  lines.push(`The life sketch is for ${subject.fullName}${years ? ` (${years})` : ''}.`);
  if (subject.knownAs) lines.push(`Most people called them ${subject.knownAs}.`);
  if (input.toneNotes) lines.push(`How the family talk about them: ${input.toneNotes}`);
  if (input.themes && input.themes.length > 0) {
    lines.push(`Threads the family named: ${input.themes.join(', ')}.`);
  }

  if (input.chapters && input.chapters.length > 0) {
    lines.push('', 'Their story as the family has written it:');
    for (const chapter of input.chapters) {
      lines.push(`  • ${chapter.title}${chapter.summary ? ` — ${oneLine(chapter.summary)}` : ''}`);
    }
  }

  if (input.anecdotes && input.anecdotes.length > 0) {
    lines.push('', 'Things the family approved, in their own words:');
    for (const anecdote of input.anecdotes.slice(0, 12)) lines.push(`  - ${oneLine(anecdote)}`);
  }

  if (input.chapters?.length === 0 && (input.anecdotes?.length ?? 0) === 0) {
    lines.push(
      '',
      'There is very little written down yet. Write only what these notes support,',
      'even if that is four sentences. Do not fill the space.',
    );
  }

  lines.push('', 'Return the sketch as paragraphs.');
  return lines.join('\n');
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
