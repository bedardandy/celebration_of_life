/**
 * The voice of the interview.
 *
 * This is the most consequential text in the product. Somebody three days after
 * a death, at eleven at night, is going to read these questions and try to
 * answer them. So: one question at a time, plain words, no performed sympathy,
 * no assumption that they want to talk about any particular thing. Skipping is
 * offered out loud, every time, because a question you cannot face should not
 * feel like a failure.
 *
 * The rule the model must never break: it does not know anything about this
 * person that the family has not said. It reflects their words back; it does
 * not supply feelings, facts, or a tidier version of a life.
 */

export type InterviewPrompt = {
  slug: string;
  /** The question, phrased for someone reading it alone. */
  text: (name: string) => string;
  /** Why we ask — used in the prompt so the model can improvise around it. */
  intent: string;
};

/**
 * A spine, not a script. The model is told to follow the person's lead; these
 * exist so the first question needs no model call at all, and so there is
 * always somewhere to go when an answer runs dry.
 */
export const INTERVIEW_PROMPTS: readonly InterviewPrompt[] = [
  {
    slug: 'beginnings',
    text: (name) => `Where did ${name}'s life begin, and what was it like there?`,
    intent: 'Place and era, gently — a factual opening that is easy to answer.',
  },
  {
    slug: 'growing-up',
    text: (name) => `What was ${name} like as a young person?`,
    intent: 'Character early on; often where the family stories already live.',
  },
  {
    slug: 'work-and-days',
    text: (name) => `How did ${name} spend their working life?`,
    intent: 'Work, vocation, the shape of ordinary days.',
  },
  {
    slug: 'home-and-people',
    text: (name) => `Who were the people closest to ${name}?`,
    intent: 'Family and friends by name, for chapters and for photo coverage.',
  },
  {
    slug: 'hands-and-hobbies',
    text: (name) => `What did ${name} do with their hands, or their spare time?`,
    intent: 'Gardening, music, cooking, making — the visual, photographable life.',
  },
  {
    slug: 'characteristic-saying',
    text: (name) => `Was there something ${name} always said?`,
    intent: 'A phrase in their own voice. Often the best line in a eulogy.',
  },
  {
    slug: 'hard-times',
    text: (name) => `Was there a hard stretch that ${name} came through?`,
    intent: 'Offered, never insisted on. Skipping this one is completely normal.',
  },
  {
    slug: 'joy',
    text: (name) => `When do you picture ${name} happiest?`,
    intent: 'The image the slideshow should end on.',
  },
  {
    slug: 'faith-and-belief',
    text: (name) => `Was there a faith, or something ${name} lived by?`,
    intent: 'Adjusted per tradition pack; secular families get a different framing.',
  },
  {
    slug: 'closing-blessing',
    text: (name) => `Is there anything you would want people to hear about ${name}?`,
    intent: 'An open door at the end, for whatever has not been asked.',
  },
];

export function promptBySlug(slug: string): InterviewPrompt | undefined {
  return INTERVIEW_PROMPTS.find((prompt) => prompt.slug === slug);
}

/** The very first question. No model call — the screen should open instantly. */
export function openingQuestion(name: string): { text: string; promptSlug: string } {
  const first = INTERVIEW_PROMPTS[0] as InterviewPrompt;
  return { text: first.text(name), promptSlug: first.slug };
}

/* -------------------------------------------------------------------------- */
/* the system prompt                                                           */
/* -------------------------------------------------------------------------- */

export const INTERVIEW_TONE = [
  'You are helping one grieving person put together the story of someone who has died.',
  'They may be exhausted, distracted, and short of time. Everything below follows from that.',
  '',
  'How to speak:',
  '- Warm and unhurried. Plain words. Short sentences. No flourishes, no poetry.',
  '- Ask ONE question at a time. Never two, never a question with a list inside it.',
  '- Follow their lead. If they open a door — a place, a person, a habit — go through',
  '  that door rather than back to your own agenda.',
  '- Reflect their own words back to them. If they say "she was a menace with a',
  '  trowel", that phrase belongs in the story, not a tidied version of it.',
  '- Make skipping easy and normal. When a question might be hard, say plainly that',
  '  it can be set aside: "We can set that aside." Never ask twice for something',
  '  they declined.',
  '- Never perform sympathy. No "what a beautiful memory", no "she sounds wonderful".',
  '  They can tell, and it costs you their trust.',
  '',
  'What you must not do:',
  '- Never invent a fact, a date, a relationship, or a feeling. If you did not hear it,',
  '  it does not go in the document. An empty summary is far better than a plausible',
  '  one that is wrong.',
  '- Never write about the death itself unless they raise it.',
  '- Never assume a faith, a family shape, or that the relationship was a happy one.',
  '- Never produce finished prose for publication. You are drafting notes the family',
  '  will approve, edit or throw away.',
  '',
  'Each reply returns: the next question, any facts you heard, and a patch to the',
  'life-story document. Anecdotes you add start unapproved — a person decides what is',
  'true about their own family, not you.',
].join('\n');

export type InterviewContext = {
  subjectName: string;
  knownAs?: string;
  birthYear?: number;
  deathYear?: number;
  /** How the organizer is related, when they said. */
  organizerRelationship?: string;
  traditionLabel?: string;
  /** From the tradition pack's `interviewAdjustments`. */
  traditionNotes?: { promptSlug: string; note: string }[];
  /** Things other people have already written in. Real family words. */
  memoryNotes?: { authorName?: string; text: string }[];
  /** The questions we have not asked yet, by slug. */
  remainingPromptSlugs?: string[];
};

export const MAX_SEEDED_MEMORY_NOTES = 12;

export function buildInterviewSystemPrompt(context: InterviewContext): string {
  const sections: string[] = [INTERVIEW_TONE, '', 'About this memorial:'];

  const years =
    context.birthYear && context.deathYear
      ? ` (${context.birthYear}–${context.deathYear})`
      : context.birthYear
        ? ` (born ${context.birthYear})`
        : '';
  sections.push(`- The person who died: ${context.subjectName}${years}.`);
  if (context.knownAs)
    sections.push(`- Most people called them ${context.knownAs}. Use that name.`);
  if (context.organizerRelationship) {
    sections.push(`- You are speaking to their ${context.organizerRelationship}.`);
  }
  if (context.traditionLabel) {
    sections.push(
      `- The family's tradition: ${context.traditionLabel}. Do not raise it yourself;` +
        ' let them bring it up.',
    );
  }

  if (context.traditionNotes && context.traditionNotes.length > 0) {
    sections.push('', 'Adjustments for this tradition:');
    for (const note of context.traditionNotes) {
      sections.push(`- ${note.promptSlug}: ${note.note}`);
    }
  }

  if (context.memoryNotes && context.memoryNotes.length > 0) {
    sections.push(
      '',
      'Other people have already sent these memories. They are real family words —',
      'use them, ask about them, but never repeat one back as though the person you',
      'are speaking to had said it:',
    );
    for (const note of context.memoryNotes.slice(0, MAX_SEEDED_MEMORY_NOTES)) {
      sections.push(`- ${note.authorName ? `${note.authorName}: ` : ''}${quote(note.text)}`);
    }
  }

  if (context.remainingPromptSlugs && context.remainingPromptSlugs.length > 0) {
    sections.push(
      '',
      'Ground you have not covered yet (a menu, not an order — skip anything that',
      'does not fit what they are telling you):',
    );
    for (const slug of context.remainingPromptSlugs) {
      const prompt = promptBySlug(slug);
      if (prompt) sections.push(`- ${slug}: ${prompt.intent}`);
    }
  }

  return sections.join('\n');
}

function quote(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > 400 ? `"${clean.slice(0, 400)}…"` : `"${clean}"`;
}

/* -------------------------------------------------------------------------- */
/* per-turn framing                                                            */
/* -------------------------------------------------------------------------- */

export type DocSummaryInput = {
  chapters: { id: string; title: string; summary: string; anecdoteCount: number }[];
  themes: string[];
  openQuestions: string[];
};

/**
 * The story so far, compressed. The durable document — not a transcript — is
 * what makes an interview resumable across days, people and providers, so this
 * is the only history the model reliably gets.
 */
export function summarizeDocForPrompt(input: DocSummaryInput): string {
  const lines: string[] = ['The story document so far:'];
  if (input.chapters.length === 0) {
    lines.push('- (empty — this is the beginning)');
  } else {
    for (const chapter of input.chapters) {
      lines.push(
        `- [${chapter.id}] ${chapter.title}: ${chapter.summary || '(no summary yet)'}` +
          ` — ${chapter.anecdoteCount} anecdote${chapter.anecdoteCount === 1 ? '' : 's'}`,
      );
    }
  }
  if (input.themes.length > 0) lines.push(`Themes so far: ${input.themes.join(', ')}.`);
  if (input.openQuestions.length > 0) {
    lines.push('Still open:', ...input.openQuestions.slice(0, 8).map((q) => `- ${q}`));
  }
  lines.push(
    '',
    'Use these chapter ids when adding to a chapter that already exists. Invent a new',
    'short kebab-case id only for genuinely new ground.',
  );
  return lines.join('\n');
}

export function buildAnswerMessage(input: {
  question: string;
  answer: string;
  skipped: boolean;
}): string {
  if (input.skipped) {
    return [
      `You asked: ${input.question}`,
      'They skipped this question. Do not ask it again, and do not comment on the skip.',
      'Move somewhere else, gently.',
    ].join('\n');
  }
  return [`You asked: ${input.question}`, '', 'They answered:', input.answer].join('\n');
}
