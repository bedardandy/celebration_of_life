/**
 * Where the interview keeps things.
 *
 * Two shapes matter. `life_story_docs` is append-only: every revision is a new
 * row with the next version number, so an interview turn that goes wrong, or an
 * organizer who changes their mind, can always be walked back to. And the
 * pending answer is a real row from the moment a question is asked, so a
 * half-typed reply survives a closed tab without any client-side storage.
 */
import {
  and,
  desc,
  eq,
  getById,
  insertOne,
  interviewSessions,
  interviewTurns,
  lifeStoryDocs,
  listAlive,
  memoryNotes,
  updateById,
  type Db,
  type InterviewSession,
  type InterviewTurn,
  type LifeStoryDocRow,
  type MemoryNote,
} from '@col/db';
import { LifeStoryDocumentSchema, type LifeStoryDocument } from '@col/schemas';
import { emptyLifeStoryDocument } from './doc-patch';

/* -------------------------------------------------------------------------- */
/* life story documents                                                        */
/* -------------------------------------------------------------------------- */

export type DocAuthor = 'interview' | 'organizer' | 'ai' | 'system';

export function latestDocRow(db: Db, memorialId: string): LifeStoryDocRow | undefined {
  return db
    .select()
    .from(lifeStoryDocs)
    .where(eq(lifeStoryDocs.memorialId, memorialId))
    .orderBy(desc(lifeStoryDocs.version))
    .limit(1)
    .all()[0];
}

export function listDocVersions(db: Db, memorialId: string): LifeStoryDocRow[] {
  return db
    .select()
    .from(lifeStoryDocs)
    .where(eq(lifeStoryDocs.memorialId, memorialId))
    .orderBy(desc(lifeStoryDocs.version))
    .all();
}

/**
 * The current document, or a fresh empty one for a memorial that has never been
 * interviewed. Never returns undefined: an empty page is the one thing the
 * story screen must never show.
 */
export function currentDoc(
  db: Db,
  memorialId: string,
  subject: { fullName: string; knownAs?: string; birthYear?: number; deathYear?: number },
): { doc: LifeStoryDocument; version: number } {
  const row = latestDocRow(db, memorialId);
  if (!row) return { doc: emptyLifeStoryDocument(subject), version: 0 };
  const parsed = LifeStoryDocumentSchema.safeParse(row.doc);
  // A stored document that no longer parses is a bug worth surfacing loudly in
  // logs, but not one worth showing a grieving family, so we fall back.
  return parsed.success
    ? { doc: parsed.data, version: row.version }
    : { doc: emptyLifeStoryDocument(subject), version: row.version };
}

/** Append a revision. Version numbers are dense and never reused. */
export function saveDocVersion(
  db: Db,
  memorialId: string,
  doc: LifeStoryDocument,
  createdBy: DocAuthor,
  note?: string,
): LifeStoryDocRow {
  const previous = latestDocRow(db, memorialId);
  return insertOne(db, lifeStoryDocs, {
    memorialId,
    version: (previous?.version ?? 0) + 1,
    doc: LifeStoryDocumentSchema.parse(doc),
    createdBy,
    ...(note ? { note } : {}),
  });
}

/* -------------------------------------------------------------------------- */
/* sessions                                                                    */
/* -------------------------------------------------------------------------- */

export function activeSession(db: Db, memorialId: string): InterviewSession | undefined {
  return db
    .select()
    .from(interviewSessions)
    .where(
      and(eq(interviewSessions.memorialId, memorialId), eq(interviewSessions.status, 'active')),
    )
    .orderBy(desc(interviewSessions.startedAt))
    .limit(1)
    .all()[0];
}

export function latestSession(db: Db, memorialId: string): InterviewSession | undefined {
  return db
    .select()
    .from(interviewSessions)
    .where(eq(interviewSessions.memorialId, memorialId))
    .orderBy(desc(interviewSessions.startedAt))
    .limit(1)
    .all()[0];
}

export function getSession(db: Db, sessionId: string): InterviewSession | undefined {
  return getById(db, interviewSessions, sessionId);
}

export function createSession(
  db: Db,
  input: { memorialId: string; participantId?: string; providerId?: string },
): InterviewSession {
  return insertOne(db, interviewSessions, {
    memorialId: input.memorialId,
    ...(input.participantId ? { participantId: input.participantId } : {}),
    ...(input.providerId ? { providerId: input.providerId } : {}),
    status: 'active',
    lastActiveAt: Date.now(),
  });
}

export function touchSession(
  db: Db,
  sessionId: string,
  patch: Partial<{
    status: 'active' | 'paused' | 'complete';
    providerSessionId: string;
    currentPromptSlug: string | null;
    turnCount: number;
  }> = {},
): InterviewSession | undefined {
  return updateById(db, interviewSessions, sessionId, { ...patch, lastActiveAt: Date.now() });
}

/* -------------------------------------------------------------------------- */
/* turns                                                                       */
/* -------------------------------------------------------------------------- */

export function listTurns(db: Db, sessionId: string): InterviewTurn[] {
  return db
    .select()
    .from(interviewTurns)
    .where(eq(interviewTurns.sessionId, sessionId))
    .orderBy(interviewTurns.idx)
    .all();
}

export function appendTurn(
  db: Db,
  input: {
    sessionId: string;
    memorialId: string;
    role: 'assistant' | 'user';
    text: string;
    promptSlug?: string | null;
    skipped?: boolean;
  },
): InterviewTurn {
  const idx = listTurns(db, input.sessionId).length;
  return insertOne(db, interviewTurns, {
    sessionId: input.sessionId,
    memorialId: input.memorialId,
    idx,
    role: input.role,
    text: input.text,
    ...(input.promptSlug ? { promptSlug: input.promptSlug } : {}),
    skipped: input.skipped ?? false,
  });
}

export function updateTurnText(db: Db, turnId: string, text: string): InterviewTurn | undefined {
  return updateById(db, interviewTurns, turnId, { text });
}

/** Skipping is a first-class answer, not a failure — and not asked again. */
export function markTurnSkipped(db: Db, turnId: string): InterviewTurn | undefined {
  return updateById(db, interviewTurns, turnId, { skipped: true });
}

/**
 * The row holding the answer being typed right now. It exists from the moment
 * the question is asked, which is what makes the draft autosave a one-line
 * update rather than a whole extra mechanism.
 */
export function pendingAnswerTurn(db: Db, sessionId: string): InterviewTurn | undefined {
  const turns = listTurns(db, sessionId);
  const last = turns[turns.length - 1];
  return last?.role === 'user' ? last : undefined;
}

/** The question currently on screen. */
export function pendingQuestionTurn(db: Db, sessionId: string): InterviewTurn | undefined {
  const turns = listTurns(db, sessionId);
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn?.role === 'assistant') return turn;
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* memory notes                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What other relatives have already written in. Feeding these to the interview
 * is the whole point of collecting them: the organizer should never be asked
 * about something a cousin already told us.
 */
export function seedMemoryNotes(db: Db, memorialId: string, limit = 12): MemoryNote[] {
  return listAlive(db, memoryNotes, eq(memoryNotes.memorialId, memorialId), limit);
}
