/**
 * Where speeches live.
 *
 * Append-only, like the life story document: every version of a speech is a new
 * row with the next number, so a tool button that made things worse, or a
 * rewrite somebody regrets at one in the morning, is always one click from
 * being undone. Nothing overwrites words a person typed.
 *
 * A `speechId` groups the versions of one person's speech. Several people speak
 * at a funeral and each of them keeps their own drafts, so "the speeches" is a
 * list of speech ids, and "the speech" is the highest version of one of them.
 */
import {
  and,
  desc,
  eq,
  insertOne,
  isNull,
  listAlive,
  listWhere,
  updateById,
  eulogyDrafts,
  newId,
  type Db,
  type EulogyDraftRow,
} from '@col/db';
import {
  EulogyNotesSchema,
  type EulogyNotes,
  type EulogyTone,
  type EulogyVariant,
} from '@col/schemas';

export type SpeechAuthor = 'organizer' | 'ai';

export const DEFAULT_TARGET_MINUTES = 5;
export const DEFAULT_TONE: EulogyTone = 'warm-with-laughter';

/* -------------------------------------------------------------------------- */
/* reading                                                                     */
/* -------------------------------------------------------------------------- */

/** Every version of one speech, newest first. */
export function listVersions(db: Db, speechId: string): EulogyDraftRow[] {
  return listAlive(db, eulogyDrafts, eq(eulogyDrafts.speechId, speechId), 2_000).sort(
    (a, b) => b.version - a.version,
  );
}

/** The current text of a speech, or of its graveside form. */
export function latestVersion(
  db: Db,
  speechId: string,
  variant: EulogyVariant = 'full',
): EulogyDraftRow | undefined {
  return listVersions(db, speechId).find((row) => row.variant === variant);
}

export function getVersion(db: Db, versionId: string): EulogyDraftRow | undefined {
  return db.select().from(eulogyDrafts).where(eq(eulogyDrafts.id, versionId)).limit(1).all()[0];
}

export type SpeechSummary = {
  speechId: string;
  current: EulogyDraftRow;
  /** How many versions exist, so the History list can say so. */
  versionCount: number;
  graveside?: EulogyDraftRow;
  /** When the speech was begun, for ordering the list. */
  startedAt: number;
};

/**
 * The landing page's whole model: one entry per speech, newest speech first,
 * each already carrying the version a person would open.
 */
export function listSpeeches(db: Db, memorialId: string): SpeechSummary[] {
  const rows = listAlive(db, eulogyDrafts, eq(eulogyDrafts.memorialId, memorialId), 2_000);
  const bySpeech = new Map<string, EulogyDraftRow[]>();
  for (const row of rows) {
    const list = bySpeech.get(row.speechId) ?? [];
    list.push(row);
    bySpeech.set(row.speechId, list);
  }

  const summaries: SpeechSummary[] = [];
  for (const [speechId, versions] of bySpeech) {
    const ordered = [...versions].sort((a, b) => b.version - a.version);
    const current = ordered.find((row) => row.variant === 'full') ?? ordered[0];
    if (!current) continue;
    const graveside = ordered.find((row) => row.variant === 'graveside');
    const first = ordered[ordered.length - 1] as EulogyDraftRow;
    summaries.push({
      speechId,
      current,
      versionCount: ordered.length,
      ...(graveside ? { graveside } : {}),
      startedAt: first.createdAt,
    });
  }

  // Oldest speech first: the order they were started is the order a family
  // thinks about them, and a list that reorders itself is a list that loses
  // people. Two speeches begun in the same millisecond fall back to their ids,
  // which are time-ordered, so the order never wobbles.
  return summaries.sort((a, b) => a.startedAt - b.startedAt || (a.speechId < b.speechId ? -1 : 1));
}

export function notesOf(row: EulogyDraftRow | undefined): EulogyNotes {
  const parsed = EulogyNotesSchema.safeParse(row?.notes ?? {});
  return parsed.success ? parsed.data : EulogyNotesSchema.parse({});
}

/* -------------------------------------------------------------------------- */
/* writing                                                                     */
/* -------------------------------------------------------------------------- */

export type CreateSpeechInput = {
  memorialId: string;
  speakerName?: string;
  relationship?: string;
  targetMinutes?: number;
  tone?: EulogyTone;
};

/**
 * A speech begins the moment somebody presses the button, before a single
 * question has been answered. There is no half-filled form to lose, and the
 * setup screens are simply the first four versions of a row that already
 * exists.
 */
export function createSpeech(db: Db, input: CreateSpeechInput): EulogyDraftRow {
  return insertOne(db, eulogyDrafts, {
    memorialId: input.memorialId,
    speechId: newId(),
    version: 1,
    variant: 'full',
    speakerName: input.speakerName?.trim() ?? '',
    ...(input.relationship ? { relationship: input.relationship } : {}),
    targetMinutes: input.targetMinutes ?? DEFAULT_TARGET_MINUTES,
    tone: input.tone ?? DEFAULT_TONE,
    body: '',
    notes: EulogyNotesSchema.parse({}),
    status: 'setup',
    createdBy: 'organizer',
    note: 'Started',
  });
}

export type SetupPatch = {
  speakerName?: string;
  relationship?: string | null;
  targetMinutes?: number;
  tone?: EulogyTone;
  selectedMemoryIds?: string[];
};

/**
 * Answers from the setup screens.
 *
 * While a speech is still in setup there are no words to protect, so these are
 * written in place — that is what makes the wizard resumable without a draft
 * state. Once a draft exists, changing the setup appends a version instead, so
 * the text that was on screen a minute ago is still recoverable.
 */
export function saveSetup(db: Db, speechId: string, patch: SetupPatch): EulogyDraftRow | undefined {
  const current = latestVersion(db, speechId);
  if (!current) return undefined;

  const notes = notesOf(current);
  const nextNotes = EulogyNotesSchema.parse({
    ...notes,
    ...(patch.selectedMemoryIds ? { selectedMemoryIds: patch.selectedMemoryIds } : {}),
  });

  const values = {
    ...(patch.speakerName === undefined ? {} : { speakerName: patch.speakerName.trim() }),
    ...(patch.relationship === undefined
      ? {}
      : { relationship: patch.relationship?.trim() || null }),
    ...(patch.targetMinutes === undefined ? {} : { targetMinutes: patch.targetMinutes }),
    ...(patch.tone === undefined ? {} : { tone: patch.tone }),
    notes: nextNotes,
  };

  if (current.status === 'setup') return updateById(db, eulogyDrafts, current.id, values);

  return appendVersion(db, {
    speechId,
    from: current,
    body: current.body,
    createdBy: 'organizer',
    note: 'Changed the setup',
    ...values,
  });
}

/**
 * The last setup screen has been answered.
 *
 * 'setup' means "the wizard is part-way through", and it is what sends somebody
 * who closed the tab back to the question they were on. Once the four questions
 * are behind them the speech is 'ready' — set up, with nothing written in it
 * yet — and the studio opens on the offer of a first draft.
 */
export function finishSetup(db: Db, speechId: string): EulogyDraftRow | undefined {
  const current = latestVersion(db, speechId);
  if (!current) return undefined;
  if (current.status !== 'setup') return current;
  return updateById(db, eulogyDrafts, current.id, { status: 'ready' });
}

export type AppendVersionInput = {
  speechId: string;
  /** The version this one follows. Its setup travels forward unchanged. */
  from: EulogyDraftRow;
  body: string;
  notes?: EulogyNotes;
  createdBy: SpeechAuthor;
  /** Why this version exists: "A little shorter", "Edited by hand". */
  note: string;
  variant?: EulogyVariant;
  status?: EulogyDraftRow['status'];
  speakerName?: string;
  relationship?: string | null;
  targetMinutes?: number;
  tone?: EulogyTone;
};

/** Version numbers are dense across a whole speech, and never reused. */
export function nextVersionNumber(db: Db, speechId: string): number {
  const rows = listVersions(db, speechId);
  return (rows[0]?.version ?? 0) + 1;
}

export function appendVersion(db: Db, input: AppendVersionInput): EulogyDraftRow {
  const from = input.from;
  return insertOne(db, eulogyDrafts, {
    memorialId: from.memorialId,
    speechId: input.speechId,
    version: nextVersionNumber(db, input.speechId),
    variant: input.variant ?? from.variant,
    speakerName: input.speakerName ?? from.speakerName,
    relationship:
      input.relationship === undefined ? from.relationship : (input.relationship ?? null),
    targetMinutes: input.targetMinutes ?? from.targetMinutes,
    tone: input.tone ?? from.tone,
    body: input.body,
    notes: input.notes ?? notesOf(from),
    status: input.status ?? (input.body.trim() ? 'draft' : from.status),
    createdBy: input.createdBy,
    note: input.note,
  });
}

/**
 * Autosave while somebody types.
 *
 * Typing does not make a new version on every keystroke — that would bury the
 * History list in noise. The current row's text is updated in place while it is
 * the person's own hand-edit; anything a model produced is never written over,
 * because a hand-edit on top of an AI version appends first.
 */
export function saveEditedBody(
  db: Db,
  speechId: string,
  body: string,
  variant: EulogyVariant = 'full',
): EulogyDraftRow | undefined {
  const current = latestVersion(db, speechId, variant);
  if (!current) return undefined;
  if (current.body === body) return current;

  if (current.createdBy === 'organizer' && current.status !== 'setup') {
    return updateById(db, eulogyDrafts, current.id, { body });
  }

  return appendVersion(db, {
    speechId,
    from: current,
    body,
    createdBy: 'organizer',
    note: 'Edited by hand',
    variant,
    status: 'draft',
  });
}

/** Bring an older version back — as a new version, so nothing is lost either way. */
export function restoreVersion(db: Db, versionId: string): EulogyDraftRow | undefined {
  const row = getVersion(db, versionId);
  if (!row) return undefined;
  const current = latestVersion(db, row.speechId, row.variant);
  if (!current || current.id === row.id) return current;
  return appendVersion(db, {
    speechId: row.speechId,
    from: current,
    body: row.body,
    notes: notesOf(row),
    createdBy: 'organizer',
    note: `Went back to version ${row.version}`,
    variant: row.variant,
    status: 'draft',
  });
}

/** Soft delete, as everywhere: the whole speech is tombstoned, undoably. */
export function removeSpeech(db: Db, speechId: string, at: number = Date.now()): number {
  const rows = listVersions(db, speechId);
  for (const row of rows) updateById(db, eulogyDrafts, row.id, { deletedAt: at });
  return rows.length;
}

export function restoreSpeech(db: Db, speechId: string): number {
  const rows = listWhere(db, eulogyDrafts, eq(eulogyDrafts.speechId, speechId), 2_000);
  for (const row of rows) updateById(db, eulogyDrafts, row.id, { deletedAt: null });
  return rows.length;
}

/**
 * How many speeches exist and how many have words in them. The shape the
 * dashboard's checklist takes, so the card and this cannot drift apart.
 */
export function countSpeeches(db: Db, memorialId: string): { started: number; drafted: number } {
  const speeches = listSpeeches(db, memorialId);
  return {
    started: speeches.length,
    drafted: speeches.filter((speech) => speech.current.body.trim().length > 0).length,
  };
}

/** The newest version of a speech, whichever variant it belongs to. */
export function newestVersion(db: Db, speechId: string): EulogyDraftRow | undefined {
  return db
    .select()
    .from(eulogyDrafts)
    .where(and(eq(eulogyDrafts.speechId, speechId), isNull(eulogyDrafts.deletedAt)))
    .orderBy(desc(eulogyDrafts.version))
    .limit(1)
    .all()[0];
}
