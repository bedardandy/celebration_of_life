/**
 * The guided interview.
 *
 * The design constraint that shapes everything here: the durable state is a
 * LifeStoryDocument plus the last few turns, held by us — not a conversation
 * living inside somebody's model. Provider sessions are used when a provider
 * has them, and ignored when it does not, and the interview behaves identically
 * either way. That is what "vendor-agnostic" has to mean in practice, and it is
 * also what lets a family come back on Thursday to something they started on
 * Monday.
 *
 * The first question is asked without an AI call at all, so the screen opens
 * instantly. Every turn after that is: answer → one structured call → a new,
 * append-only document version.
 */
import {
  INTERVIEW_PROMPTS,
  buildAnswerMessage,
  buildInterviewSystemPrompt,
  generateObject,
  openingQuestion,
  resolveProvider,
  summarizeDocForPrompt,
  type AiMessage,
  type AiProvider,
  type InterviewContext,
} from '@col/ai';
import { newId, type Db, type InterviewSession, type Memorial } from '@col/db';
import {
  InterviewTurnSchema,
  type InterviewTurnResult,
  type LifeStoryDocument,
} from '@col/schemas';
import { findPack } from '@col/tradition-packs';
import {
  applyDocPatch,
  approveAnecdoteInDoc,
  docProgress,
  editAnecdoteInDoc,
  removeAnecdoteFromDoc,
} from './doc-patch';
import {
  appendTurn,
  activeSession,
  createSession,
  currentDoc,
  getSession,
  latestSession,
  listTurns,
  markTurnSkipped,
  pendingAnswerTurn,
  pendingQuestionTurn,
  saveDocVersion,
  seedMemoryNotes,
  touchSession,
  updateTurnText,
  type DocAuthor,
} from './store';

/** How much conversation travels with each call. Six turns is three exchanges. */
export const CONTEXT_TURN_WINDOW = 6;

/** Every question in the spine, in order. Used to say what is still uncovered. */
export const INTERVIEW_PROMPT_SLUGS: readonly string[] = INTERVIEW_PROMPTS.map(
  (prompt) => prompt.slug,
);

export const INTERVIEW_TASK_TAG = 'interview';

export type InterviewSubject = {
  fullName: string;
  knownAs?: string;
  birthYear?: number;
  deathYear?: number;
};

export type InterviewState = {
  session: InterviewSession;
  /** The question on screen now. */
  question: { text: string; promptSlug: string | null };
  /** Whatever they had typed when they last stopped. */
  draft: string;
  doc: LifeStoryDocument;
  docVersion: number;
  /** Answers given so far, skips included. */
  answered: number;
  progress: ReturnType<typeof docProgress>;
  coverageNote?: string;
};

/* -------------------------------------------------------------------------- */
/* reading                                                                     */
/* -------------------------------------------------------------------------- */

export function subjectOf(memorial: Memorial): InterviewSubject {
  return {
    fullName: memorial.decedentName,
    ...(memorial.decedentKnownAs ? { knownAs: memorial.decedentKnownAs } : {}),
    ...(memorial.birthYear ? { birthYear: memorial.birthYear } : {}),
    ...(memorial.deathYear ? { deathYear: memorial.deathYear } : {}),
  };
}

/** First name, or the whole thing when there is only one word. */
export function shortName(subject: InterviewSubject): string {
  return subject.knownAs?.trim() || subject.fullName.trim().split(/\s+/)[0] || subject.fullName;
}

/** The live interview, if there is one. Returning here must always resume. */
export function readInterview(db: Db, memorial: Memorial): InterviewState | undefined {
  const session = activeSession(db, memorial.id);
  if (!session) return undefined;
  return stateFor(db, memorial, session);
}

/** Whether anything has been said yet — decides intro screen vs question. */
export function hasStarted(db: Db, memorialId: string): boolean {
  return latestSession(db, memorialId) !== undefined;
}

function stateFor(db: Db, memorial: Memorial, session: InterviewSession): InterviewState {
  const subject = subjectOf(memorial);
  const { doc, version } = currentDoc(db, memorial.id, subject);
  const question = pendingQuestionTurn(db, session.id);
  const pending = pendingAnswerTurn(db, session.id);
  const turns = listTurns(db, session.id);

  return {
    session,
    question: {
      text: question?.text ?? openingQuestion(shortName(subject)).text,
      promptSlug: question?.promptSlug ?? null,
    },
    draft: pending?.text ?? '',
    doc,
    docVersion: version,
    // The pending row is not an answer yet.
    answered: turns.filter((turn) => turn.role === 'user' && turn.id !== pending?.id).length,
    progress: docProgress(doc),
  };
}

/* -------------------------------------------------------------------------- */
/* starting                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Begin, or pick up where they left off. Idempotent: pressing "Begin" twice
 * does not start two interviews, which matters because double-tapping a button
 * is exactly what a tired person does.
 */
export function startInterview(
  db: Db,
  memorial: Memorial,
  options: { participantId?: string; providerId?: string } = {},
): InterviewState {
  const existing = activeSession(db, memorial.id);
  if (existing) return stateFor(db, memorial, existing);

  const subject = subjectOf(memorial);
  const session = createSession(db, {
    memorialId: memorial.id,
    ...(options.participantId ? { participantId: options.participantId } : {}),
    ...(options.providerId ? { providerId: options.providerId } : {}),
  });

  const opening = openingQuestion(shortName(subject));
  askQuestion(db, session, memorial.id, opening.text, opening.promptSlug);
  touchSession(db, session.id, { currentPromptSlug: opening.promptSlug });

  // A document exists from the first moment, so nothing downstream has to cope
  // with "no story yet".
  if (currentDoc(db, memorial.id, subject).version === 0) {
    saveDocVersion(db, memorial.id, currentDoc(db, memorial.id, subject).doc, 'system', 'started');
  }

  const refreshed = activeSession(db, memorial.id) ?? session;
  return stateFor(db, memorial, refreshed);
}

/** Ask, and open the row the answer will be typed into. */
function askQuestion(
  db: Db,
  session: InterviewSession,
  memorialId: string,
  text: string,
  promptSlug: string | null,
): void {
  appendTurn(db, {
    sessionId: session.id,
    memorialId,
    role: 'assistant',
    text,
    promptSlug,
  });
  appendTurn(db, { sessionId: session.id, memorialId, role: 'user', text: '' });
}

/* -------------------------------------------------------------------------- */
/* the draft                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Autosave. There is no Save button in this product, and closing the tab
 * mid-sentence has to cost nothing.
 */
export function saveDraft(db: Db, sessionId: string, text: string): { saved: true } {
  const pending = pendingAnswerTurn(db, sessionId);
  if (pending) updateTurnText(db, pending.id, text);
  touchSession(db, sessionId);
  return { saved: true };
}

/* -------------------------------------------------------------------------- */
/* a turn                                                                      */
/* -------------------------------------------------------------------------- */

export type SubmitAnswerInput = {
  memorial: Memorial;
  sessionId: string;
  text: string;
  skipped?: boolean;
  /** Injected in tests; otherwise resolved from the environment. */
  provider?: AiProvider;
};

export type SubmitAnswerResult = InterviewState & {
  turn: InterviewTurnResult;
  /** True when the document actually gained something from this answer. */
  docChanged: boolean;
};

/**
 * One exchange: record what they said, ask the model for a structured turn,
 * fold the patch into a new document version, and put the next question up.
 *
 * Errors are not caught here. The caller decides what a person sees; this
 * layer's job is to make sure that when it throws, nothing has been half-written
 * — the answer row is saved before the call, and the document version is only
 * appended after a successful parse.
 */
export async function submitAnswer(db: Db, input: SubmitAnswerInput): Promise<SubmitAnswerResult> {
  const { memorial, sessionId } = input;
  const session = requireSession(db, sessionId, memorial.id);
  const subject = subjectOf(memorial);
  const skipped = input.skipped ?? false;
  const answer = input.text.trim();

  // Written first, so a provider failure never costs them what they typed.
  const pending = pendingAnswerTurn(db, sessionId);
  if (pending) {
    updateTurnText(db, pending.id, answer);
    // Skipping is a real answer, recorded as one, so we never ask again.
    if (skipped) markTurnSkipped(db, pending.id);
  }

  const question = pendingQuestionTurn(db, sessionId);
  const provider = input.provider ?? resolveProvider('interview');
  const { doc, version } = currentDoc(db, memorial.id, subject);

  const messages = buildTurnMessages({
    db,
    memorial,
    session,
    doc,
    question: question?.text ?? openingQuestion(shortName(subject)).text,
    answer,
    skipped,
  });

  const generated = await generateObject(provider, InterviewTurnSchema, {
    messages,
    taskTag: INTERVIEW_TASK_TAG,
    ...(session.providerSessionId && provider.capabilities.nativeSessions
      ? { sessionId: session.providerSessionId }
      : {}),
  });
  const turn = generated.object;

  const applied = applyDocPatch(doc, turn.docPatch, { newId });
  let nextVersion = version;
  if (applied.changed) {
    const row = saveDocVersion(
      db,
      memorial.id,
      applied.doc,
      'interview',
      question?.promptSlug ?? undefined,
    );
    nextVersion = row.version;
  }

  askQuestion(
    db,
    session,
    memorial.id,
    turn.nextQuestion.text,
    turn.nextQuestion.promptSlug ?? null,
  );

  const updated =
    touchSession(db, sessionId, {
      currentPromptSlug: turn.nextQuestion.promptSlug ?? null,
      ...(generated.sessionId && provider.capabilities.nativeSessions
        ? { providerSessionId: generated.sessionId }
        : {}),
      turnCount: session.turnCount + 1,
    }) ?? session;

  const state = stateFor(db, memorial, updated);
  return {
    ...state,
    doc: applied.doc,
    docVersion: nextVersion,
    progress: docProgress(applied.doc),
    ...(turn.coverage.note ? { coverageNote: turn.coverage.note } : {}),
    turn,
    docChanged: applied.changed,
  };
}

/* -------------------------------------------------------------------------- */
/* prompt assembly                                                             */
/* -------------------------------------------------------------------------- */

export function buildTurnMessages(input: {
  db: Db;
  memorial: Memorial;
  session: InterviewSession;
  doc: LifeStoryDocument;
  question: string;
  answer: string;
  skipped: boolean;
}): AiMessage[] {
  const { db, memorial, session, doc } = input;
  const subject = subjectOf(memorial);
  const pack = findPack(memorial.traditionSlug);
  const notes = seedMemoryNotes(db, memorial.id);
  const asked = new Set(
    listTurns(db, session.id)
      .map((turn) => turn.promptSlug)
      .filter((slug): slug is string => Boolean(slug)),
  );

  const context: InterviewContext = {
    subjectName: shortName(subject),
    ...(subject.knownAs ? { knownAs: subject.knownAs } : {}),
    ...(subject.birthYear ? { birthYear: subject.birthYear } : {}),
    ...(subject.deathYear ? { deathYear: subject.deathYear } : {}),
    ...(memorial.organizerRelationship
      ? { organizerRelationship: memorial.organizerRelationship }
      : {}),
    ...(pack ? { traditionLabel: pack.label, traditionNotes: [...pack.interviewAdjustments] } : {}),
    memoryNotes: notes.map((note) => ({
      ...(note.authorName ? { authorName: note.authorName } : {}),
      text: note.text,
    })),
    remainingPromptSlugs: remainingPrompts(asked),
  };

  const messages: AiMessage[] = [
    { role: 'system', content: buildInterviewSystemPrompt(context) },
    {
      role: 'user',
      content: summarizeDocForPrompt({
        chapters: doc.chapters.map((chapter) => ({
          id: chapter.id,
          title: chapter.title,
          summary: chapter.summary,
          anecdoteCount: chapter.anecdotes.length,
        })),
        themes: doc.themes,
        openQuestions: doc.chapters.flatMap((chapter) => chapter.openQuestions),
      }),
    },
  ];

  for (const turn of recentTurns(db, session.id)) {
    if (turn.text.trim().length === 0) continue;
    messages.push({
      role: turn.role === 'assistant' ? 'assistant' : 'user',
      content: turn.text,
    });
  }

  messages.push({
    role: 'user',
    content: buildAnswerMessage({
      question: input.question,
      answer: input.answer,
      skipped: input.skipped,
    }),
  });
  return messages;
}

/** The last few turns, excluding the pending answer row (which is now empty). */
function recentTurns(db: Db, sessionId: string) {
  const turns = listTurns(db, sessionId).filter((turn) => turn.text.trim().length > 0);
  // The final question/answer pair is stated explicitly in the closing message,
  // so it is dropped here to avoid saying the same thing twice.
  return turns.slice(0, Math.max(0, turns.length - 2)).slice(-CONTEXT_TURN_WINDOW);
}

function remainingPrompts(asked: ReadonlySet<string>): string[] {
  return INTERVIEW_PROMPT_SLUGS.filter((slug) => !asked.has(slug));
}

/* -------------------------------------------------------------------------- */
/* ending                                                                      */
/* -------------------------------------------------------------------------- */

/** "I'm done for now." Not an ending — the session is paused, never closed. */
export function pauseInterview(db: Db, sessionId: string): InterviewSession | undefined {
  return touchSession(db, sessionId, { status: 'paused' });
}

/** Reopening a paused interview: the pending question is still waiting. */
export function resumeInterview(db: Db, memorial: Memorial): InterviewState {
  const existing = activeSession(db, memorial.id) ?? latestSession(db, memorial.id);
  if (!existing) return startInterview(db, memorial);
  if (existing.status !== 'active') touchSession(db, existing.id, { status: 'active' });
  const session = activeSession(db, memorial.id);
  return session ? stateFor(db, memorial, session) : startInterview(db, memorial);
}

/* -------------------------------------------------------------------------- */
/* organizer control of anecdotes                                              */
/* -------------------------------------------------------------------------- */

export type AnecdoteAction = 'approve' | 'edit' | 'remove';

export function applyAnecdoteAction(
  db: Db,
  input: {
    memorial: Memorial;
    chapterId: string;
    anecdoteId: string;
    action: AnecdoteAction;
    text?: string;
  },
): { doc: LifeStoryDocument; version: number; changed: boolean } {
  const subject = subjectOf(input.memorial);
  const { doc, version } = currentDoc(db, input.memorial.id, subject);
  const ref = { chapterId: input.chapterId, anecdoteId: input.anecdoteId };

  const next =
    input.action === 'approve'
      ? approveAnecdoteInDoc(doc, ref)
      : input.action === 'edit'
        ? editAnecdoteInDoc(doc, ref, input.text ?? '')
        : removeAnecdoteFromDoc(doc, ref);

  if (!next) return { doc, version, changed: false };

  const author: DocAuthor = 'organizer';
  const row = saveDocVersion(db, input.memorial.id, next, author, input.action);
  return { doc: next, version: row.version, changed: true };
}

/** A session id from a form is user input; it has to belong to this memorial. */
function requireSession(db: Db, sessionId: string, memorialId: string): InterviewSession {
  const session = getSession(db, sessionId);
  if (!session || session.memorialId !== memorialId) {
    throw new Error(`interview session ${sessionId} does not belong to memorial ${memorialId}`);
  }
  return session;
}
