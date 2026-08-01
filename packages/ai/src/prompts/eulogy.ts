/**
 * Drafting a eulogy without taking it away from the person giving it.
 *
 * The research is unambiguous: families welcome AI as scaffolding and resent it
 * as a replacement. So this prompt is built to hand back something that is
 * recognisably *theirs* — assembled out of memories they themselves ticked, in
 * the shape a eulogy actually takes (who you are → a brief sketch of the life →
 * one to three specific stories → what they meant to you), and short enough
 * that the speaker has room to add.
 *
 * Two rules are load-bearing rather than stylistic:
 *  - it may only lean on the memories it was given, and assembly checks that;
 *  - anything inside quotation marks must be a word-for-word copy of one of
 *    them. Assembly strips the quotation marks off anything else, because a
 *    sentence a model improved, delivered at a funeral in someone's name, is
 *    not a thing that can be taken back afterwards.
 */

/** Task tag and fixture folder for eulogy work: `fixtures/ai/eulogy/`. */
export const EULOGY_TASK = 'eulogy';

export const MEMORY_SEPARATOR = ' :: ';

/** Spoken words per minute, unhurried, at a lectern. */
export const SPOKEN_WORDS_PER_MINUTE = 130;

export function wordsForMinutes(minutes: number): number {
  return Math.round(minutes * SPOKEN_WORDS_PER_MINUTE);
}

export type EulogyPromptMemory = {
  /** Stable id, so the draft can say which ones it used. */
  id: string;
  text: string;
  /** Whose words these are: "Her daughter, Anne". */
  attribution: string;
};

export type EulogyPromptSubject = {
  fullName: string;
  knownAs?: string;
  birthYear?: number;
  deathYear?: number;
};

export type EulogyTonePrompt = 'warm-with-laughter' | 'quiet-and-simple' | 'faithful';

export type EulogyPromptInput = {
  subject: EulogyPromptSubject;
  /** The person who will stand up and read this. */
  speakerName: string;
  /** How they were related, in their own words. */
  relationship?: string;
  targetMinutes: number;
  tone: EulogyTonePrompt;
  /** Only the memories the speaker ticked. Nothing else may be leaned on. */
  memories: readonly EulogyPromptMemory[];
  /** Chapters from the family's own story document, for the life sketch. */
  storyChapters?: readonly { title: string; summary?: string }[];
  themes?: readonly string[];
  toneNotes?: string;
  /** Placement and custom guidance from the tradition pack, in its own words. */
  traditionNotes?: string;
};

export const EULOGY_SYSTEM_PROMPT = [
  'You are helping one person write the few minutes they will speak at a funeral.',
  '',
  'They are the author. You are producing a first draft they will rewrite, and',
  'the draft should read like something they could have written on a good day —',
  'plain, specific, unhurried. Not a piece of writing. Not a performance.',
  '',
  'The shape a eulogy takes, and the one to follow unless the material says',
  'otherwise:',
  '  1. who the speaker is and how they were related — one or two sentences;',
  '  2. a brief sketch of the life, in a short paragraph, not a chronology;',
  '  3. one to three specific stories that show what the person was like;',
  '  4. what they meant to the speaker, and a plain closing line.',
  '',
  'How to write it:',
  '- Be specific, never sweeping. "She kept a spare coat by the door for whoever',
  '  turned up cold" is a eulogy. "She was always generous" is a greetings card.',
  '- Short sentences. Words the speaker already uses. No poetry, no rhetoric, no',
  '  three-part lists building to a crescendo.',
  '- Aim slightly under the length asked for. Speakers add; they rarely cut.',
  '',
  'What you must never do:',
  '- Never tell the speaker how they feel, or write "I feel" for them. You do not',
  '  know. Describe what happened and let the feeling be theirs.',
  '- Never invent a fact, a date, a relationship, a saying or a scene. Everything',
  '  concrete must come from the memories and story notes you were given.',
  "- Never put words in the dead person's mouth unless a memory quotes them.",
  '- Never write about the death itself, or about an afterlife, unless the notes',
  '  already do.',
  '- Never use quotation marks around anything that is not a word-for-word copy',
  '  of one of the approved memories. If you want to use a memory but not quote',
  '  it, retell it in plain narrative with no quotation marks at all.',
  '',
  'You may mark a held beat by putting [pause] on its own as a paragraph, once or',
  'twice at most, where a speaker will need a moment. Do not mark more than that.',
].join('\n');

/** `~ 0 :: mem-4 :: Her daughter, Anne :: She kept a spare coat …` */
export function memoryPromptLine(index: number, memory: EulogyPromptMemory): string {
  return [`~ ${index}`, memory.id, memory.attribution, oneLine(memory.text)].join(MEMORY_SEPARATOR);
}

const MEMORY_LINE_RE = /^~\s*(\d+)\s::\s(.+?)\s::\s(.+?)\s::\s(.+)$/;

export type ParsedEulogyMemoryLine = {
  index: number;
  id: string;
  attribution: string;
  text: string;
};

/** Read back what {@link memoryPromptLine} wrote. The mock provider needs this. */
export function parseEulogyMemoryLines(text: string): ParsedEulogyMemoryLine[] {
  const out: ParsedEulogyMemoryLine[] = [];
  for (const line of text.split('\n')) {
    const match = MEMORY_LINE_RE.exec(line.trim());
    if (!match) continue;
    const [, index, id, attribution, body] = match;
    if (!index || !id || !attribution || !body) continue;
    out.push({
      index: Number.parseInt(index, 10),
      id: id.trim(),
      attribution: attribution.trim(),
      text: body.trim(),
    });
  }
  return out;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

const TONE_SENTENCE: Record<EulogyTonePrompt, string> = {
  'warm-with-laughter':
    'Warm, and there is room for a laugh. If a memory is funny, let it be funny — ' +
    'people laughing at a funeral is a kindness, not a lapse.',
  'quiet-and-simple':
    'Quiet and simple. Short sentences, nothing raised, nothing decorative. ' +
    'Let the plainness carry it.',
  faithful:
    "Faithful in tone, in the family's own register. Use only the religious " +
    'language the notes already use; do not add prayers, verses or promises of ' +
    'your own.',
};

export function buildEulogyPrompt(input: EulogyPromptInput): string {
  const { subject } = input;
  const years =
    subject.birthYear && subject.deathYear
      ? `${subject.birthYear}–${subject.deathYear}`
      : subject.birthYear
        ? `born ${subject.birthYear}`
        : '';

  const lines: string[] = [];
  lines.push(`This eulogy is for ${subject.fullName}${years ? ` (${years})` : ''}.`);
  if (subject.knownAs) lines.push(`Most people called them ${subject.knownAs}. Use that name.`);
  lines.push(
    '',
    `Speaking: ${input.speakerName}${input.relationship ? `, ${input.relationship}` : ''}.`,
    `Length: about ${input.targetMinutes} minutes, which is roughly ` +
      `${wordsForMinutes(input.targetMinutes)} spoken words. Come in a little under it.`,
    `Tone: ${TONE_SENTENCE[input.tone]}`,
  );

  if (input.traditionNotes) lines.push(`About the gathering: ${input.traditionNotes}`);
  if (input.toneNotes) lines.push(`How the family talks about them: ${input.toneNotes}`);
  if (input.themes && input.themes.length > 0) {
    lines.push(`Threads the family already named: ${input.themes.join(', ')}.`);
  }

  if (input.storyChapters && input.storyChapters.length > 0) {
    lines.push('', 'The life, as the family has written it down so far:');
    for (const chapter of input.storyChapters) {
      lines.push(`  • ${chapter.title}${chapter.summary ? ` — ${oneLine(chapter.summary)}` : ''}`);
    }
  }

  if (input.memories.length > 0) {
    lines.push(
      '',
      `${input.speakerName} chose these memories to build the speech around. They are the`,
      'only material you may use for the stories, and anything you put in quotation',
      'marks must copy one of them word for word, or carry no quotation marks at all:',
      '',
    );
    input.memories.forEach((memory, index) => lines.push(memoryPromptLine(index, memory)));
    lines.push('', 'List the ids of the memories you actually used in usedMemoryIds.');
  } else {
    lines.push(
      '',
      'No memories were chosen, so tell the life from the story notes above and keep',
      'it short. Use no quotation marks anywhere.',
    );
  }

  lines.push('', 'Return the opening line, the body in paragraphs, and the closing line.');
  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/* revisions                                                                   */
/* -------------------------------------------------------------------------- */

export type EulogyRevision = 'shorter' | 'longer' | 'warmer' | 'simpler' | 'graveside';

/**
 * What each button asks for.
 *
 * Every one of them is a small, reversible move: the previous version is one
 * click away, so the instruction can be modest rather than defensive.
 */
export const REVISION_INSTRUCTIONS: Record<EulogyRevision, string> = {
  shorter:
    'Make this a little shorter — about a fifth shorter. Cut whole sentences rather ' +
    'than trimming words out of them, and keep every specific detail: the names, ' +
    'the places, the things that actually happened. Generalities go first.',
  longer:
    'Make this a little longer — about a fifth longer. Do not add new facts, new ' +
    'scenes or new feelings. Give the stories that are already here more room: a ' +
    'detail already mentioned, a sentence of setting, a slower closing.',
  warmer:
    'Make this warmer. Keep every fact exactly as it is. Let the speaker sound like ' +
    'someone who knew them well rather than someone reporting: plainer verbs, a ' +
    'little more of the ordinary. Do not add sentiment the notes do not support, ' +
    'and do not tell the speaker how they feel.',
  simpler:
    'Use simpler words. Anything that would sound like writing when read aloud, ' +
    'say the plain way instead. Shorter sentences. Nothing formal, nothing ' +
    'literary. Keep the length about the same and keep every fact.',
  graveside:
    'Cut this down to about ninety seconds — roughly 200 spoken words — for the ' +
    'graveside, where people are standing in the cold. Keep one story, the ' +
    'relationship, and the closing line. Everything inside quotation marks must ' +
    'still copy an approved memory word for word.',
};

export type EulogyRevisionInput = {
  revision: EulogyRevision;
  /** The version on screen right now, as the person has it. */
  currentBody: string;
  openingLine?: string;
  closingLine?: string;
  /** The same list the draft was built from. Still the only material allowed. */
  memories: readonly EulogyPromptMemory[];
  targetMinutes: number;
  speakerName: string;
};

export function buildEulogyRevisionPrompt(input: EulogyRevisionInput): string {
  const lines: string[] = [
    `Speaking: ${input.speakerName}.`,
    `Length: about ${input.targetMinutes} minutes, roughly ` +
      `${wordsForMinutes(input.targetMinutes)} spoken words.`,
    '',
    REVISION_INSTRUCTIONS[input.revision],
    '',
    'The speech as it stands:',
    '',
  ];
  if (input.openingLine) lines.push(input.openingLine, '');
  lines.push(input.currentBody.trim());
  if (input.closingLine) lines.push('', input.closingLine);

  if (input.memories.length > 0) {
    lines.push(
      '',
      'The approved memories, unchanged. Quotation marks may only go around a',
      'word-for-word copy of one of these:',
      '',
    );
    input.memories.forEach((memory, index) => lines.push(memoryPromptLine(index, memory)));
  }

  lines.push('', 'Return the whole speech again: opening line, body, closing line.');
  return lines.join('\n');
}
