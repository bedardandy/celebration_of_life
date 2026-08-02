'use server';

/**
 * Going through what family said.
 *
 * Both buttons do the same small thing — move a note out of the way — and both
 * are undoable for eight seconds afterwards, because "Done" pressed on the
 * wrong row is exactly the mis-tap a tired person makes. Nothing here deletes
 * anything: a dismissed note is still there, still readable, still somebody's
 * words.
 */
import { revalidatePath } from 'next/cache';
import { setReviewNoteStatus, type ReviewNoteStatus } from '@col/core';
import { db } from '@/server/db';
import { requireOrganizer } from '@/server/auth';

const STATUSES: ReviewNoteStatus[] = ['open', 'done', 'dismissed'];

export type NoteChange = {
  message: string;
  /** What it was before, so the Undo can put it back exactly. */
  previous: ReviewNoteStatus;
};

export async function setNoteStatusAction(
  memorialId: string,
  noteId: string,
  status: ReviewNoteStatus,
): Promise<NoteChange> {
  await requireOrganizer(memorialId);
  const wanted = STATUSES.includes(status) ? status : 'open';
  const result = setReviewNoteStatus(db(), memorialId, noteId, wanted);
  revalidatePath(`/m/${memorialId}/review`);
  revalidatePath(`/m/${memorialId}`);
  return {
    message: result?.message ?? 'Nothing changed.',
    previous: result?.previous ?? 'open',
  };
}
