'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  addPhotoNote,
  setDupeRepresentative,
  toggleApproval,
  toggleHidden,
  toggleNeedsIdentification,
} from '@col/core';
import { db } from '@/server/db';
import { requireOrganizer } from '@/server/auth';

/**
 * Every action on this screen is a single tap that writes immediately. There is
 * no Save, no confirmation and no batch: a person going through two hundred
 * photos at midnight should be able to stop at any moment and lose nothing.
 *
 * They all take a form post rather than a client callback so the grid works
 * with JavaScript disabled or still loading, which on a slow connection is the
 * first thirty seconds.
 */
function target(formData: FormData): { memorialId: string; assetId: string; back: string } {
  const memorialId = String(formData.get('memorialId') ?? '');
  const assetId = String(formData.get('assetId') ?? '');
  const anchor = assetId ? `#photo-${assetId}` : '';
  return { memorialId, assetId, back: `/m/${memorialId}/curate${anchor}` };
}

export async function toggleApprovalAction(formData: FormData): Promise<void> {
  const { memorialId, assetId, back } = target(formData);
  await requireOrganizer(memorialId);
  toggleApproval(db(), memorialId, assetId);
  revalidatePath(`/m/${memorialId}/curate`);
  redirect(back);
}

export async function toggleHiddenAction(formData: FormData): Promise<void> {
  const { memorialId, assetId, back } = target(formData);
  await requireOrganizer(memorialId);
  toggleHidden(db(), memorialId, assetId);
  revalidatePath(`/m/${memorialId}/curate`);
  redirect(back);
}

export async function toggleWhoIsThisAction(formData: FormData): Promise<void> {
  const { memorialId, assetId, back } = target(formData);
  await requireOrganizer(memorialId);
  toggleNeedsIdentification(db(), memorialId, assetId);
  revalidatePath(`/m/${memorialId}/curate`);
  redirect(back);
}

/** "Show this one instead" — the family's choice outranks the sharpness score. */
export async function chooseRepresentativeAction(formData: FormData): Promise<void> {
  const { memorialId, assetId, back } = target(formData);
  await requireOrganizer(memorialId);
  setDupeRepresentative(db(), memorialId, assetId);
  revalidatePath(`/m/${memorialId}/curate`);
  redirect(back);
}

export async function addNoteAction(formData: FormData): Promise<void> {
  const { memorialId, assetId, back } = target(formData);
  const text = String(formData.get('note') ?? '');
  const { participant } = await requireOrganizer(memorialId);

  addPhotoNote(db(), {
    memorialId,
    assetId,
    participantId: participant.id,
    authorName: participant.displayName,
    promptSlug: 'organizer-note',
    text,
    // The organiser writing about their own family does not need approving.
    approved: true,
  });

  revalidatePath(`/m/${memorialId}/curate`);
  redirect(back);
}
