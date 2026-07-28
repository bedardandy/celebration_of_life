/**
 * Asking a model to put a life in order.
 *
 * The division of labour is the whole design: the model decides *sequence,
 * grouping and words*; the code decides every number. It never sees a duration,
 * a frame rate or a rectangle, so there is no version of this call that can
 * produce a slideshow which is eleven minutes long or a Ken Burns move that
 * flies off the edge of a photograph.
 *
 * Two rules are load-bearing rather than stylistic:
 *  - it may only use the asset ids it was given, and assembly checks that
 *  - a quote card must be a word-for-word copy of something a real person
 *    wrote, and assembly checks that too. A memorial is not the place to find
 *    out that an AI tidied up a sentence someone's daughter wrote at midnight.
 */

/** Task tag and fixture folder for EDL work: `fixtures/ai/edl/`. */
export const EDL_TASK = 'edl';

export const ASSET_SEPARATOR = ' :: ';

export type EdlPromptAsset = {
  assetId: string;
  /** '1960s', or undefined when nobody knows. */
  eraGuess?: string;
  description?: string;
  emotionalTone?: string;
  settingTags?: readonly string[];
  /** 0..1 from the photo analysis pass. The model sees it; it does not set it. */
  suitability?: number;
  suggestedCaption?: string;
};

export type EdlPromptQuote = {
  text: string;
  /** Who said or wrote it: "Her daughter, Anne". */
  attribution: string;
};

export type EdlPromptSubject = {
  fullName: string;
  knownAs?: string;
  birthYear?: number;
  deathYear?: number;
};

export type EdlPromptInput = {
  subject: EdlPromptSubject;
  assets: readonly EdlPromptAsset[];
  quotes: readonly EdlPromptQuote[];
  /** Chapters and themes the family's own story document already has. */
  storyChapters?: readonly { title: string; summary?: string }[];
  themes?: readonly string[];
  toneNotes?: string;
  structure: 'chrono' | 'thematic' | 'mixed';
  /** Roughly how long the family cut should run. Guidance only — code fits it. */
  targetSec: number;
  /** Placement guidance from the tradition pack, in the pack's own words. */
  traditionNotes?: string;
};

export const EDL_SYSTEM_PROMPT = [
  'You are helping a family put their photographs in an order that tells a life.',
  '',
  'You decide three things and nothing else: which chapters the slideshow has,',
  'which photographs belong in each and in what order, and the few words that',
  'appear on the opening and closing cards.',
  '',
  'You do not decide how long anything is on screen, how it moves, or how it',
  'transitions. Those are worked out afterwards, in code, from the length the',
  'family asked for.',
  '',
  'Hard rules:',
  '- Use only the asset ids listed. Never invent one, never alter one.',
  '- Every listed photograph should appear exactly once unless it genuinely',
  '  repeats another; a photograph nobody uses is a person nobody sees.',
  '- A quote card must be an exact, word-for-word copy of one of the approved',
  '  memories, with the attribution as given. Do not shorten, tidy or improve',
  '  it. If none fits a chapter, leave the chapter without one.',
  '- The closing card is plain: their name, their years, and at most one quiet',
  '  line. No blessing, no promise about an afterlife, no "rest in peace"',
  '  unless the family already used those words.',
  '- Captions, if you write them, are short and factual — a place, a year, who',
  '  is in the picture. Never a sentiment the family did not express.',
  '',
  'kenBurns is a focal hint, not a movement: say where the eye should settle.',
  'Use face-left or face-right when the subject sits to one side, center for a',
  'straightforward portrait, and wide for a landscape, a group, or anything that',
  'would lose something if it were cropped in.',
].join('\n');

/** One line per photograph: the id we need back, and what is known about it. */
export function assetPromptLine(asset: EdlPromptAsset): string {
  const facts: string[] = [];
  facts.push(asset.eraGuess ? asset.eraGuess : 'era unknown');
  if (asset.description) facts.push(asset.description);
  if (asset.settingTags && asset.settingTags.length > 0) facts.push(asset.settingTags.join(', '));
  if (asset.emotionalTone) facts.push(asset.emotionalTone);
  if (asset.suitability != null)
    facts.push(`carries a full screen: ${asset.suitability.toFixed(2)}`);
  if (asset.suggestedCaption) facts.push(`caption idea: ${asset.suggestedCaption}`);
  return `- ${asset.assetId}${ASSET_SEPARATOR}${facts.join(' — ')}`;
}

/** `~ 0 :: Her daughter, Anne :: She always said …` */
export function quotePromptLine(index: number, quote: EdlPromptQuote): string {
  return `~ ${index}${ASSET_SEPARATOR}${quote.attribution}${ASSET_SEPARATOR}${oneLine(quote.text)}`;
}

const ASSET_LINE_RE = /^-\s*(\S+)\s::\s(.*)$/;
const QUOTE_LINE_RE = /^~\s*(\d+)\s::\s(.+?)\s::\s(.+)$/;

export type ParsedEdlAssetLine = { assetId: string; facts: string };

/** Read back what {@link assetPromptLine} wrote. The mock provider needs this. */
export function parseEdlAssetLines(text: string): ParsedEdlAssetLine[] {
  const out: ParsedEdlAssetLine[] = [];
  for (const line of text.split('\n')) {
    const match = ASSET_LINE_RE.exec(line.trim());
    const assetId = match?.[1];
    if (!assetId) continue;
    out.push({ assetId, facts: match?.[2]?.trim() ?? '' });
  }
  return out;
}

export type ParsedEdlQuoteLine = { index: number; attribution: string; text: string };

export function parseEdlQuoteLines(text: string): ParsedEdlQuoteLine[] {
  const out: ParsedEdlQuoteLine[] = [];
  for (const line of text.split('\n')) {
    const match = QUOTE_LINE_RE.exec(line.trim());
    if (!match) continue;
    const [, index, attribution, quoted] = match;
    if (!index || !attribution || !quoted) continue;
    out.push({
      index: Number.parseInt(index, 10),
      attribution: attribution.trim(),
      text: quoted.trim(),
    });
  }
  return out;
}

/** Quotes travel on one line each, so they can be parsed back reliably. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function buildEdlPrompt(input: EdlPromptInput): string {
  const { subject, assets, quotes } = input;
  const years =
    subject.birthYear && subject.deathYear
      ? `${subject.birthYear}–${subject.deathYear}`
      : subject.birthYear
        ? `born ${subject.birthYear}`
        : '';

  const lines: string[] = [];
  lines.push(`This slideshow is for ${subject.fullName}${years ? ` (${years})` : ''}.`);
  if (subject.knownAs) lines.push(`Most people called them ${subject.knownAs}.`);
  lines.push(
    '',
    `Shape the story ${structureSentence(input.structure)}`,
    `Aim for roughly ${Math.round(input.targetSec / 60)} minutes of photographs — that is about ` +
      `${Math.round(input.targetSec / 4.5)} slides. Group them into chapters of five to fifteen.`,
  );

  if (input.themes && input.themes.length > 0) {
    lines.push('', `Threads the family already named: ${input.themes.join(', ')}.`);
  }
  if (input.toneNotes) lines.push(`How they talk about them: ${input.toneNotes}`);
  if (input.traditionNotes) lines.push(`About the gathering: ${input.traditionNotes}`);

  if (input.storyChapters && input.storyChapters.length > 0) {
    lines.push('', 'Chapters their written story already has:');
    for (const chapter of input.storyChapters) {
      lines.push(`  • ${chapter.title}${chapter.summary ? ` — ${oneLine(chapter.summary)}` : ''}`);
    }
  }

  lines.push('', 'Photographs available (use these ids exactly, and no others):', '');
  for (const asset of assets) lines.push(assetPromptLine(asset));

  if (quotes.length > 0) {
    lines.push(
      '',
      'Approved memories. A quote card must copy one of these word for word,',
      'attribution included, or not exist at all:',
      '',
    );
    quotes.forEach((quote, index) => lines.push(quotePromptLine(index, quote)));
  } else {
    lines.push('', 'No memories have been approved yet, so use no quote cards.');
  }

  lines.push('', 'Return the opening title card, the chapters in order, and the closing card.');
  return lines.join('\n');
}

function structureSentence(structure: EdlPromptInput['structure']): string {
  switch (structure) {
    case 'chrono':
      return 'in time order, earliest photographs first, ending near the end of their life.';
    case 'thematic':
      return 'around the things that mattered to them rather than around dates.';
    default:
      return 'loosely in time order, but let a strong theme keep its photographs together.';
  }
}
