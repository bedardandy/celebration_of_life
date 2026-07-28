'use server';

import { revalidatePath } from 'next/cache';
import { restore, softDelete } from '@col/core';
import { db } from '@/server/db';
import { requireOrganizer } from '@/server/auth';

/**
 * Removing a memorial writes a tombstone and nothing more. The interface then
 * offers Undo for a few seconds; a purge job deals with the real deletion
 * later, deliberately.
 */
export async function removeMemorialAction(memorialId: string): Promise<{ message: string }> {
  await requireOrganizer(memorialId);
  const result = softDelete(db(), 'memorial', memorialId);
  revalidatePath(`/m/${memorialId}`);
  return { message: result?.message ?? 'Removed. Nothing is deleted yet.' };
}

export async function restoreMemorialAction(memorialId: string): Promise<void> {
  // `allowRemoved` because the memorial is tombstoned at this point: the usual
  // check would refuse the very session that just removed it, and the Undo
  // button would be a lie.
  await requireOrganizer(memorialId, { allowRemoved: true });
  restore(db(), 'memorial', memorialId);
  revalidatePath(`/m/${memorialId}`);
}
