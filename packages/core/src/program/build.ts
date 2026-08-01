/**
 * Building the printed program, one decision at a time.
 *
 * Everything here is a starting point rather than a template: the order of
 * service arrives already filled in from the family's own tradition pack, the
 * acknowledgement already has words in it, and every one of them is editable.
 * A family three days after a death should be correcting a draft, not facing an
 * empty box with "Order of service" written above it.
 */
import {
  LIFE_SKETCH_SYSTEM_PROMPT,
  PROGRAM_TASK,
  buildLifeSketchPrompt,
  generateObject,
  resolveProvider,
  type AiProvider,
} from '@col/ai';
import {
  LifeSketchDraftSchema,
  type ProgramDocument,
  type ProgramReading,
  type TraditionPack,
} from '@col/schemas';
import type { Db, Memorial } from '@col/db';
import { getPack } from '@col/tradition-packs';
import { currentDoc } from '../interview/store';
import { subjectOf } from '../interview/engine';
import { formatServiceDate } from '../memorial/pacing';

export const PROGRAM_STEPS = ['cover', 'order', 'sketch', 'reading', 'thanks'] as const;
export type ProgramStep = (typeof PROGRAM_STEPS)[number];

export function isProgramStep(value: unknown): value is ProgramStep {
  return typeof value === 'string' && (PROGRAM_STEPS as readonly string[]).includes(value);
}

export function programStepIndex(step: ProgramStep): number {
  return PROGRAM_STEPS.indexOf(step);
}

export function nextProgramStep(step: ProgramStep): ProgramStep | undefined {
  return PROGRAM_STEPS[programStepIndex(step) + 1];
}

export function previousProgramStep(step: ProgramStep): ProgramStep | undefined {
  const index = programStepIndex(step);
  return index > 0 ? PROGRAM_STEPS[index - 1] : undefined;
}

/** "1936 — 2024", or as much of it as anybody knows. */
export function lifeDatesOf(memorial: Pick<Memorial, 'birthYear' | 'deathYear'>): string {
  if (memorial.birthYear && memorial.deathYear)
    return `${memorial.birthYear} — ${memorial.deathYear}`;
  if (memorial.deathYear) return `${memorial.deathYear}`;
  if (memorial.birthYear) return `${memorial.birthYear} —`;
  return '';
}

/**
 * The program a family starts from: their name, their dates, the order of
 * service their tradition usually follows, and an acknowledgement already
 * written out in plain words.
 */
export function emptyProgram(memorial: Memorial, pack: TraditionPack): ProgramDocument {
  const serviceLine = memorial.serviceDate
    ? formatServiceDate(memorial.serviceDate, memorial.timezone)
    : '';

  return {
    coverLine: 'In Loving Memory',
    fullName: memorial.decedentName,
    lifeDates: lifeDatesOf(memorial),
    serviceLine,
    orderOfService: pack.orderOfService.map((entry) => ({
      item: entry.item,
      ...(entry.note ? { note: entry.note } : {}),
    })),
    lifeSketch: '',
    acknowledgments: defaultAcknowledgment(memorial.decedentName),
    backNote: '',
  };
}

/**
 * The thank-you on the back page.
 *
 * Written out rather than left blank because this is the sentence organisers
 * most often tell us they could not face composing, and because every family
 * ends up saying more or less this.
 */
export function defaultAcknowledgment(decedentName: string): string {
  const first = decedentName.split(/\s+/)[0] ?? decedentName;
  return (
    `The family of ${decedentName} thank you for every kindness shown to them: for the ` +
    `cards and the calls, for the food left on doorsteps, and for being here today. ` +
    `${first} would have been glad to see you all together.`
  );
}

/** Readings this tradition reaches for, plus room for the family's own. */
export function readingSuggestions(traditionSlug: string): ProgramReading[] {
  try {
    return [...getPack(traditionSlug).readings];
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* editing the order of service                                                */
/* -------------------------------------------------------------------------- */

export function addOrderItem(doc: ProgramDocument, item: string, note?: string): ProgramDocument {
  const trimmed = item.trim();
  if (!trimmed) return doc;
  return {
    ...doc,
    orderOfService: [
      ...doc.orderOfService,
      { item: trimmed.slice(0, 120), ...(note?.trim() ? { note: note.trim().slice(0, 300) } : {}) },
    ],
  };
}

export function removeOrderItem(doc: ProgramDocument, index: number): ProgramDocument {
  return { ...doc, orderOfService: doc.orderOfService.filter((_, i) => i !== index) };
}

/**
 * Buttons rather than dragging. Drag-and-drop on a phone, by somebody who has
 * not slept, is how a running order ends up in the wrong sequence.
 */
export function moveOrderItem(doc: ProgramDocument, index: number, delta: number): ProgramDocument {
  const items = [...doc.orderOfService];
  const target = index + delta;
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) return doc;
  const moved = items[index] as (typeof items)[number];
  items.splice(index, 1);
  items.splice(target, 0, moved);
  return { ...doc, orderOfService: items };
}

export function renameOrderItem(
  doc: ProgramDocument,
  index: number,
  item: string,
  note?: string,
): ProgramDocument {
  const trimmed = item.trim();
  if (!trimmed) return doc;
  return {
    ...doc,
    orderOfService: doc.orderOfService.map((entry, i) =>
      i === index
        ? {
            item: trimmed.slice(0, 120),
            ...(note?.trim() ? { note: note.trim().slice(0, 300) } : {}),
          }
        : entry,
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* the life sketch                                                             */
/* -------------------------------------------------------------------------- */

export type LifeSketchResult = {
  /** Paragraphs, blank-line separated, ready for the editing box. */
  text: string;
  providerId: string;
  attempts: number;
};

/**
 * A hundred and fifty to two hundred and fifty words, drafted from what the
 * family has already written down and nothing else.
 */
export async function draftLifeSketch(
  db: Db,
  memorial: Memorial,
  options: { provider?: AiProvider } = {},
): Promise<LifeSketchResult> {
  const provider = options.provider ?? resolveProvider('program');
  const subject = subjectOf(memorial);
  const { doc } = currentDoc(db, memorial.id, subject);

  const anecdotes: string[] = [];
  for (const chapter of doc.chapters) {
    for (const anecdote of chapter.anecdotes) {
      if (anecdote.approved && anecdote.text.trim()) anecdotes.push(anecdote.text.trim());
    }
  }

  const prompt = buildLifeSketchPrompt({
    subject,
    chapters: doc.chapters.map((chapter) => ({
      title: chapter.title,
      ...(chapter.summary ? { summary: chapter.summary } : {}),
    })),
    anecdotes,
    themes: doc.themes,
    ...(doc.toneNotes ? { toneNotes: doc.toneNotes } : {}),
  });

  const result = await generateObject(provider, LifeSketchDraftSchema, {
    taskTag: PROGRAM_TASK,
    messages: [
      { role: 'system', content: LIFE_SKETCH_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
  });

  return {
    text: result.object.paragraphs.map((paragraph) => paragraph.trim()).join('\n\n'),
    providerId: provider.id,
    attempts: result.attempts,
  };
}

/* -------------------------------------------------------------------------- */
/* how far along it is                                                         */
/* -------------------------------------------------------------------------- */

export type ProgramProgress = {
  /** Enough to hand to a printer. */
  ready: boolean;
  /** What is still missing, in words, never as a scolding list. */
  line: string;
  steps: { step: ProgramStep; done: boolean }[];
};

export function programProgress(doc: ProgramDocument): ProgramProgress {
  const steps: { step: ProgramStep; done: boolean }[] = [
    { step: 'cover', done: Boolean(doc.coverAssetId) },
    { step: 'order', done: doc.orderOfService.length > 0 },
    { step: 'sketch', done: doc.lifeSketch.trim().length > 0 },
    { step: 'reading', done: doc.reading !== undefined },
    { step: 'thanks', done: doc.acknowledgments.trim().length > 0 },
  ];

  const ready = steps.filter((entry) => entry.step !== 'reading').every((entry) => entry.done);
  const missing = steps.filter((entry) => !entry.done).map((entry) => entry.step);

  const line = ready
    ? 'Ready to print. You can keep changing it right up to the day.'
    : missing.includes('sketch')
      ? 'The life sketch is the part most families want help with. We can draft it from their story.'
      : missing.includes('cover')
        ? 'Choose the photograph for the front, and the rest is nearly done.'
        : 'A few things left. Nothing here has to be finished in one sitting.';

  return { ready, line, steps };
}
