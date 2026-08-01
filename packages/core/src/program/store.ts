/**
 * Where the printed program lives between screens.
 *
 * Append-only, like the life story: the wording of a program gets argued over
 * by three people in two time zones, and "put it back how it was an hour ago"
 * has to be a real answer.
 */
import {
  desc,
  eq,
  insertOne,
  programDocs,
  updateById,
  type Db,
  type Memorial,
  type ProgramDocRow,
} from '@col/db';
import { ProgramDocumentSchema, type ProgramDocument } from '@col/schemas';
import { getPack } from '@col/tradition-packs';
import { emptyProgram } from './build';

export type ProgramAuthor = 'organizer' | 'ai' | 'system';

export function latestProgramRow(db: Db, memorialId: string): ProgramDocRow | undefined {
  return db
    .select()
    .from(programDocs)
    .where(eq(programDocs.memorialId, memorialId))
    .orderBy(desc(programDocs.version))
    .limit(1)
    .all()[0];
}

export function listProgramVersions(db: Db, memorialId: string): ProgramDocRow[] {
  return db
    .select()
    .from(programDocs)
    .where(eq(programDocs.memorialId, memorialId))
    .orderBy(desc(programDocs.version))
    .all();
}

/**
 * The current program, or a sensible starting one for a family who has never
 * opened this screen. Never undefined: a blank page is the one thing this
 * product does not show anybody.
 */
export function currentProgram(
  db: Db,
  memorial: Memorial,
): { doc: ProgramDocument; version: number } {
  const row = latestProgramRow(db, memorial.id);
  const starting = () => emptyProgram(memorial, getPack(memorial.traditionSlug));
  if (!row) return { doc: starting(), version: 0 };
  const parsed = ProgramDocumentSchema.safeParse(row.doc);
  // A stored document that no longer parses is a bug worth shouting about in
  // the logs and worth hiding from a grieving family.
  return parsed.success
    ? { doc: parsed.data, version: row.version }
    : { doc: starting(), version: row.version };
}

/** Append a revision. Version numbers are dense and never reused. */
export function saveProgramVersion(
  db: Db,
  memorialId: string,
  doc: ProgramDocument,
  createdBy: ProgramAuthor,
  note?: string,
): ProgramDocRow {
  const previous = latestProgramRow(db, memorialId);
  return insertOne(db, programDocs, {
    memorialId,
    version: (previous?.version ?? 0) + 1,
    doc: ProgramDocumentSchema.parse(doc),
    createdBy,
    ...(note ? { note } : {}),
  });
}

/**
 * An organizer's own edit.
 *
 * Typing does not make a version per keystroke — that would bury the history in
 * noise — so a revision the organizer already owns is updated in place. Anything
 * a model wrote is never written over: the first hand edit on top of an AI
 * version appends, which is what makes "put the drafted one back" a real offer.
 */
export function saveOrganizerEdit(
  db: Db,
  memorialId: string,
  doc: ProgramDocument,
  note?: string,
): ProgramDocRow {
  const previous = latestProgramRow(db, memorialId);
  if (previous && previous.createdBy === 'organizer') {
    const updated = updateById(db, programDocs, previous.id, {
      doc: ProgramDocumentSchema.parse(doc),
      ...(note ? { note } : {}),
    });
    if (updated) return updated;
  }
  return saveProgramVersion(db, memorialId, doc, 'organizer', note);
}

/** Whether a family has started the program at all. Used by the dashboard card. */
export function hasProgram(db: Db, memorialId: string): boolean {
  return latestProgramRow(db, memorialId) !== undefined;
}
