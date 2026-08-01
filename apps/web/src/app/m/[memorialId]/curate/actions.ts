'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  acceptEnhancement,
  addPhotoNote,
  dismissFaceCluster,
  nameFaceCluster,
  requestEnhancement,
  revertEnhancement,
  setDupeRepresentative,
  startFaceGrouping,
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

/* -------------------------------------------------------------------------- */
/* faces                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * "Find the same faces."
 *
 * The consent sentence is on the button's own card, and this is the only thing
 * that starts face grouping: nothing runs on upload, nothing runs on a
 * schedule, and the work never leaves this machine.
 */
export async function startFaceGroupingAction(formData: FormData): Promise<void> {
  const memorialId = String(formData.get('memorialId') ?? '');
  await requireOrganizer(memorialId);
  startFaceGrouping(db(), memorialId);
  revalidatePath(`/m/${memorialId}/curate`);
  redirect(`/m/${memorialId}/curate?faces=started#faces`);
}

/** "This is Ruth." */
export async function nameClusterAction(formData: FormData): Promise<void> {
  const memorialId = String(formData.get('memorialId') ?? '');
  const clusterId = String(formData.get('clusterId') ?? '');
  const name = String(formData.get('name') ?? '').trim();
  await requireOrganizer(memorialId);

  // An empty name is somebody pressing the button before typing, not an error.
  if (name) nameFaceCluster(db(), { memorialId, clusterId, name });

  revalidatePath(`/m/${memorialId}/curate`);
  redirect(`/m/${memorialId}/curate#faces`);
}

/** "Not the same person." The suggestion goes; the photographs stay. */
export async function dismissClusterAction(formData: FormData): Promise<void> {
  const memorialId = String(formData.get('memorialId') ?? '');
  const clusterId = String(formData.get('clusterId') ?? '');
  await requireOrganizer(memorialId);
  dismissFaceCluster(db(), memorialId, clusterId);
  revalidatePath(`/m/${memorialId}/curate`);
  redirect(`/m/${memorialId}/curate#faces`);
}

/* -------------------------------------------------------------------------- */
/* improving a photograph                                                      */
/* -------------------------------------------------------------------------- */

/** Queues the work. The original is not touched by any of this. */
export async function improvePhotoAction(formData: FormData): Promise<void> {
  const { memorialId, assetId, back } = target(formData);
  await requireOrganizer(memorialId);
  requestEnhancement(db(), memorialId, assetId);
  revalidatePath(`/m/${memorialId}/curate`);
  redirect(back);
}

/** "Use the improved version." Reversible, and the screen says so. */
export async function useImprovedAction(formData: FormData): Promise<void> {
  const { memorialId, assetId, back } = target(formData);
  await requireOrganizer(memorialId);
  acceptEnhancement(db(), memorialId, assetId);
  revalidatePath(`/m/${memorialId}/curate`);
  redirect(back);
}

/** "Keep the original." The improved copy stays on disk, unused. */
export async function keepOriginalAction(formData: FormData): Promise<void> {
  const { memorialId, assetId, back } = target(formData);
  await requireOrganizer(memorialId);
  revertEnhancement(db(), memorialId, assetId);
  revalidatePath(`/m/${memorialId}/curate`);
  redirect(back);
}
