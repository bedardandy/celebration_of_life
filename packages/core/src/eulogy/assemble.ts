/**
 * Turning a model's draft into a speech somebody can safely stand up and read.
 *
 * The rule is the EDL's quote-card rule, one step further along: anything
 * inside quotation marks must be a word-for-word copy of a memory the speaker
 * ticked. If it is not, the quotation marks come off and the sentence stays as
 * narrative — the draft is not destroyed, but it stops claiming that somebody
 * said something they did not.
 *
 * Dropping the marks rather than deleting the sentence is deliberate. This is a
 * first draft, the speaker rewrites it anyway, and losing a paragraph without
 * explanation is worse than losing a pair of quotation marks with one.
 */
import { PAUSE_MARKER, type EulogyDraft } from '@col/schemas';
import { normalizeQuote } from '../edl/generate';
import { countSpokenWords } from './timer';
import type { SelectableMemory } from './memories';

export type EulogyMemoryInput = Pick<SelectableMemory, 'id' | 'text' | 'attribution'>;

export type AssembledEulogy = {
  openingLine: string;
  /** Paragraphs, blank-line separated. `[pause]` markers left where they are. */
  body: string;
  closingLine: string;
  /** Only ids the speaker actually ticked, and only ones the draft used. */
  usedMemoryIds: string[];
  /** What was quietly changed, in words a person could be shown. */
  warnings: string[];
  wordCount: number;
};

/* -------------------------------------------------------------------------- */
/* verbatim checking                                                           */
/* -------------------------------------------------------------------------- */

/** Terminal punctuation is typography, not words. Everything else is a rewrite. */
function comparable(text: string): string {
  return normalizeQuote(text)
    .replace(/^[.,;:!?—–-]+|[.,;:!?—–-]+$/g, '')
    .trim();
}

/**
 * The approved memory this quotation is a copy of, if it is a copy of one.
 *
 * Deliberately unforgiving, for the same reason the slideshow's quote cards
 * are: "close enough" is how a sentence someone's son wrote at midnight turns
 * into a sentence a language model preferred, read out loud, in a church, with
 * no way for anyone afterwards to tell which one it was.
 */
export function matchApprovedMemory(
  text: string,
  memories: readonly EulogyMemoryInput[],
): EulogyMemoryInput | undefined {
  const wanted = comparable(text);
  if (!wanted) return undefined;
  return memories.find((memory) => comparable(memory.text) === wanted);
}

/** Double quotation marks only. Single ones are apostrophes far too often. */
const QUOTED = /[“"]([^“”"]{2,})[”"]/g;

export type QuoteCheck = { text: string; warnings: string[] };

/**
 * Take the quotation marks off anything that is not a word-for-word copy.
 *
 * The sentence survives; only the claim that it is a quotation does not.
 */
export function enforceVerbatimQuotes(
  paragraph: string,
  memories: readonly EulogyMemoryInput[],
): QuoteCheck {
  const warnings: string[] = [];
  const text = paragraph.replace(QUOTED, (whole, inner: string) => {
    const approved = matchApprovedMemory(inner, memories);
    if (approved) return whole;
    warnings.push(
      `took the quotation marks off “${shorten(inner)}” — it is not word for word ` +
        'what anyone actually wrote, so it now reads as your own telling of it',
    );
    return inner.trim();
  });
  return { text, warnings };
}

function shorten(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > 60 ? `${clean.slice(0, 60)}…` : clean;
}

/* -------------------------------------------------------------------------- */
/* assembly                                                                    */
/* -------------------------------------------------------------------------- */

export const MAX_PAUSE_MARKERS = 3;

/**
 * Draft in, speech out, with every claim checked.
 *
 * Nothing here calls a model. It is the same shape as the EDL's `assembleEdl`:
 * one call decides the words, and this decides what is allowed to survive.
 */
export function assembleEulogy(
  draft: EulogyDraft,
  memories: readonly EulogyMemoryInput[],
): AssembledEulogy {
  const warnings: string[] = [];
  const paragraphs: string[] = [];
  let pauses = 0;

  const opening = enforceVerbatimQuotes(draft.openingLine.trim(), memories);
  warnings.push(...opening.warnings);
  const closing = enforceVerbatimQuotes(draft.closingLine.trim(), memories);
  warnings.push(...closing.warnings);

  for (const raw of draft.body) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    if (trimmed.toLowerCase() === PAUSE_MARKER) {
      // A speech held up by pauses is a speech nobody can read. Keep the first
      // few, drop the rest without comment — they are only a suggestion.
      if (pauses >= MAX_PAUSE_MARKERS) continue;
      if (paragraphs.length === 0) continue;
      pauses += 1;
      paragraphs.push(PAUSE_MARKER);
      continue;
    }

    const checked = enforceVerbatimQuotes(trimmed, memories);
    warnings.push(...checked.warnings);
    paragraphs.push(checked.text);
  }

  const allowed = new Set(memories.map((memory) => memory.id));
  const used: string[] = [];
  for (const id of draft.usedMemoryIds) {
    if (!allowed.has(id)) {
      warnings.push(`ignored a memory the draft claimed to use but you had not chosen (${id})`);
      continue;
    }
    if (!used.includes(id)) used.push(id);
  }

  const body = paragraphs.join('\n\n');
  return {
    openingLine: opening.text,
    body,
    closingLine: closing.text,
    usedMemoryIds: used,
    warnings,
    wordCount: countSpokenWords([opening.text, body, closing.text].join('\n\n')),
  };
}

/**
 * The whole speech as one block of text: what goes in the editing box, what
 * gets printed, and what the timer reads. Opening and closing lines are
 * paragraphs like any other once a person starts editing — keeping them apart
 * in the box would only be a structure to fight.
 */
export function fullText(assembled: {
  openingLine: string;
  body: string;
  closingLine: string;
}): string {
  return [assembled.openingLine, assembled.body, assembled.closingLine]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join('\n\n');
}
