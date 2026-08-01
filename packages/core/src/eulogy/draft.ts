/**
 * The four model calls the eulogy studio makes, and what happens to what comes
 * back.
 *
 * One call writes the first draft. Three more sit behind buttons — shorter,
 * longer, warmer, simpler — and the graveside distillation is the same
 * machinery with a different instruction. Every one of them goes through
 * `assembleEulogy` before it is stored, so the verbatim rule holds no matter
 * which button produced the words.
 *
 * Nothing here writes to the database. The caller decides whether a version is
 * appended, which is what keeps "the model failed" and "the person lost their
 * work" two entirely separate events.
 */
import type { EulogyTone, EulogyVariant } from '@col/schemas';
import { EulogyDraftSchema } from '@col/schemas';
import {
  EULOGY_TASK,
  EULOGY_SYSTEM_PROMPT,
  buildEulogyPrompt,
  buildEulogyRevisionPrompt,
  generateObject,
  resolveProvider,
  type AiProvider,
  type EulogyPromptMemory,
  type EulogyRevision,
} from '@col/ai';
import type { Db, Memorial } from '@col/db';
import { getPack } from '@col/tradition-packs';
import { currentDoc } from '../interview/store';
import { subjectOf } from '../interview/engine';
import { assembleEulogy, type AssembledEulogy, type EulogyMemoryInput } from './assemble';
import type { SelectableMemory } from './memories';

export type EulogyBuildContext = {
  subject: { fullName: string; knownAs?: string; birthYear?: number; deathYear?: number };
  speakerName: string;
  relationship?: string;
  targetMinutes: number;
  tone: EulogyTone;
  /** Only what the speaker ticked. The single most important line here. */
  memories: readonly SelectableMemory[];
  storyChapters?: readonly { title: string; summary?: string }[];
  themes?: readonly string[];
  toneNotes?: string;
  traditionNotes?: string;
};

export type EulogyDraftResult = AssembledEulogy & {
  providerId: string;
  attempts: number;
};

function promptMemories(memories: readonly SelectableMemory[]): EulogyPromptMemory[] {
  return memories.map((memory) => ({
    id: memory.id,
    text: memory.text,
    attribution: memory.attribution,
  }));
}

function memoryInputs(memories: readonly SelectableMemory[]): EulogyMemoryInput[] {
  return memories.map((memory) => ({
    id: memory.id,
    text: memory.text,
    attribution: memory.attribution,
  }));
}

/**
 * The first draft.
 *
 * Seeded with the family's own story document, the tradition's guidance, and
 * the memories this speaker chose — and nothing else. A speaker who ticked two
 * memories gets a draft built on two memories, which is short, and honest, and
 * far better than a fuller one containing something nobody said.
 */
export async function draftEulogy(
  context: EulogyBuildContext,
  options: { provider?: AiProvider } = {},
): Promise<EulogyDraftResult> {
  const provider = options.provider ?? resolveProvider('eulogy');
  const prompt = buildEulogyPrompt({
    subject: context.subject,
    speakerName: context.speakerName || 'A member of the family',
    ...(context.relationship ? { relationship: context.relationship } : {}),
    targetMinutes: context.targetMinutes,
    tone: context.tone,
    memories: promptMemories(context.memories),
    ...(context.storyChapters ? { storyChapters: context.storyChapters } : {}),
    ...(context.themes ? { themes: context.themes } : {}),
    ...(context.toneNotes ? { toneNotes: context.toneNotes } : {}),
    ...(context.traditionNotes ? { traditionNotes: context.traditionNotes } : {}),
  });

  const result = await generateObject(provider, EulogyDraftSchema, {
    taskTag: EULOGY_TASK,
    messages: [
      { role: 'system', content: EULOGY_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
  });

  return {
    ...assembleEulogy(result.object, memoryInputs(context.memories)),
    providerId: provider.id,
    attempts: result.attempts,
  };
}

export type ReviseEulogyInput = {
  revision: EulogyRevision;
  /** The speech exactly as it is on screen, opening and closing lines included. */
  currentBody: string;
  memories: readonly SelectableMemory[];
  targetMinutes: number;
  speakerName: string;
};

/**
 * One button, one call, one new version.
 *
 * The instruction is modest in every case, because the previous version is
 * always one click away — a tool that can be undone can afford to be gentle.
 */
export async function reviseEulogy(
  input: ReviseEulogyInput,
  options: { provider?: AiProvider } = {},
): Promise<EulogyDraftResult> {
  const provider = options.provider ?? resolveProvider('eulogy');
  const prompt = buildEulogyRevisionPrompt({
    revision: input.revision,
    currentBody: input.currentBody,
    memories: promptMemories(input.memories),
    targetMinutes: input.targetMinutes,
    speakerName: input.speakerName || 'A member of the family',
  });

  const result = await generateObject(provider, EulogyDraftSchema, {
    taskTag: EULOGY_TASK,
    messages: [
      { role: 'system', content: EULOGY_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
  });

  return {
    ...assembleEulogy(result.object, memoryInputs(input.memories)),
    providerId: provider.id,
    attempts: result.attempts,
  };
}

/** What each button is called on screen, and what it says underneath. */
export const REVISION_LABELS: Record<
  EulogyRevision,
  { label: string; help: string; note: string; variant?: EulogyVariant }
> = {
  shorter: {
    label: 'A little shorter',
    help: 'Takes out whole sentences and keeps every specific detail.',
    note: 'A little shorter',
  },
  longer: {
    label: 'A little longer',
    help: 'Gives the stories already here more room. Adds no new facts.',
    note: 'A little longer',
  },
  warmer: {
    label: 'Warmer',
    help: 'Same facts, said the way you would say them out loud.',
    note: 'Warmer',
  },
  simpler: {
    label: 'Simpler words',
    help: 'Anything that sounds like writing, said the plain way instead.',
    note: 'Simpler words',
  },
  graveside: {
    label: 'Make a graveside version',
    help: 'About ninety seconds, for standing outside. Kept alongside the full speech.',
    note: 'Graveside version',
    variant: 'graveside',
  },
};

/* -------------------------------------------------------------------------- */
/* gathering the context                                                       */
/* -------------------------------------------------------------------------- */

export type ContextOptions = {
  speakerName: string;
  relationship?: string | null;
  targetMinutes: number;
  tone: EulogyTone;
  memories: readonly SelectableMemory[];
};

/**
 * Everything a eulogy call needs, gathered in one pass: the life story the
 * family has written, the threads they named, and the tradition's own words
 * about the gathering this will be spoken at.
 */
export function buildEulogyContext(
  db: Db,
  memorial: Memorial,
  options: ContextOptions,
): EulogyBuildContext {
  const subject = subjectOf(memorial);
  const { doc } = currentDoc(db, memorial.id, subject);
  const pack = getPack(memorial.traditionSlug);
  const placement = pack.mediaPlacement[0];

  return {
    subject,
    speakerName: options.speakerName,
    ...(options.relationship ? { relationship: options.relationship } : {}),
    targetMinutes: options.targetMinutes,
    tone: options.tone,
    memories: options.memories,
    storyChapters: doc.chapters.map((chapter) => ({
      title: chapter.title,
      ...(chapter.summary ? { summary: chapter.summary } : {}),
    })),
    themes: doc.themes,
    ...(doc.toneNotes ? { toneNotes: doc.toneNotes } : {}),
    ...(placement ? { traditionNotes: `${placement.context}: ${placement.guidance}` } : {}),
  };
}

/**
 * Which tones to offer first, read out of the tradition pack's own words.
 *
 * There is no `if (tradition === 'catholic')` here. A pack whose guidance talks
 * about hymns and prayer puts the faithful option in front; a pack that talks
 * about celebration leads with laughter; everything else keeps the plain order.
 * Being wrong costs a speaker one extra glance, which is the right amount of
 * risk to take in exchange for never branching on somebody's religion.
 */
export function toneOptionsFor(traditionSlug: string): EulogyTone[] {
  const plain: EulogyTone[] = ['warm-with-laughter', 'quiet-and-simple', 'faithful'];
  let text = '';
  try {
    const pack = getPack(traditionSlug);
    text = [pack.serviceTimelineNote, ...pack.musicGuidance].join(' ').toLowerCase();
  } catch {
    return plain;
  }
  // Restraint is read first: a tradition that asks for a plain, quiet funeral
  // means it more strongly than one that merely mentions a hymn.
  if (/minimal or absent|deliberately simple|restrain|solemn|subdued/.test(text)) {
    return ['quiet-and-simple', 'warm-with-laughter', 'faithful'];
  }
  if (/hymn|sacred|liturg|psalm|prayer|scripture|chant/.test(text)) {
    return ['faithful', 'warm-with-laughter', 'quiet-and-simple'];
  }
  return plain;
}

export const TONE_LABELS: Record<EulogyTone, { label: string; note: string }> = {
  'warm-with-laughter': {
    label: 'Warm, with some laughter',
    note: 'People laughing at a funeral is a kindness. If a story is funny, it stays funny.',
  },
  'quiet-and-simple': {
    label: 'Quiet and simple',
    note: 'Short sentences, nothing raised, nothing decorative.',
  },
  faithful: {
    label: 'Faithful',
    note: 'In your family’s own religious language — only the words you already use.',
  },
};
