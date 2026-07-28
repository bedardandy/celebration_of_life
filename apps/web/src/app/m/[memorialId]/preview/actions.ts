'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  EdlEditError,
  applyEditAndRefit,
  latestProject,
  projectEdl,
  saveEdl,
  type EdlEdit,
} from '@col/core';
import { getById, mediaAssets, type Db } from '@col/db';
import { db } from '@/server/db';
import { requireOrganizer } from '@/server/auth';

/**
 * Every adjustment on the preview screen goes through here.
 *
 * They are all form posts rather than client calls, so the whole screen keeps
 * working with JavaScript still loading — which on a phone in a kitchen with
 * one bar is the first thirty seconds. Each one writes immediately and bumps
 * the EDL version, which is what makes the player pick the change up without a
 * page reload.
 */
type Target = { memorialId: string; slideId: string; cut: string; back: string };

function target(formData: FormData): Target {
  const memorialId = String(formData.get('memorialId') ?? '');
  const slideId = String(formData.get('slideId') ?? '');
  const cut = String(formData.get('cut') ?? 'family');
  const query = cut === 'service' ? '?cut=service' : '';
  const anchor = slideId ? `#slide-${slideId}` : '';
  return { memorialId, slideId, cut, back: `/m/${memorialId}/preview${query}${anchor}` };
}

async function apply(formData: FormData, make: (t: Target) => EdlEdit): Promise<Target> {
  const t = target(formData);
  await requireOrganizer(t.memorialId);

  const project = latestProject(db(), t.memorialId);
  const edl = projectEdl(project);
  if (!project || !edl) redirect(`/m/${t.memorialId}/story-shape`);

  try {
    saveEdl(db(), project.id, applyEditAndRefit(edl, make(t)));
  } catch (error) {
    // An edit that no longer makes sense (a slide someone else already removed)
    // is not worth an error page: the screen re-renders and shows what is true.
    if (!(error instanceof EdlEditError)) throw error;
  }

  revalidatePath(`/m/${t.memorialId}/preview`);
  return t;
}

/** Button presses come back to the row they were pressed on. */
async function edit(formData: FormData, make: (t: Target) => EdlEdit): Promise<void> {
  const t = await apply(formData, make);
  redirect(t.back);
}

/**
 * Captions save themselves as they are typed, so this one does not redirect:
 * yanking the page to an anchor mid-sentence would be a worse bug than no
 * autosave at all.
 */
export async function setCaptionAction(formData: FormData): Promise<void> {
  const text = String(formData.get('caption') ?? '');
  await apply(formData, (t) => ({ op: 'caption', slideId: t.slideId, text }));
}

export async function moveUpAction(formData: FormData): Promise<void> {
  return edit(formData, (t) => ({ op: 'move-up', slideId: t.slideId }));
}

export async function moveDownAction(formData: FormData): Promise<void> {
  return edit(formData, (t) => ({ op: 'move-down', slideId: t.slideId }));
}

export async function longerAction(formData: FormData): Promise<void> {
  return edit(formData, (t) => ({ op: 'longer', slideId: t.slideId }));
}

export async function shorterAction(formData: FormData): Promise<void> {
  return edit(formData, (t) => ({ op: 'shorter', slideId: t.slideId }));
}

export async function removeSlideAction(formData: FormData): Promise<void> {
  return edit(formData, (t) => ({ op: 'remove', slideId: t.slideId }));
}

export async function restoreSlideAction(formData: FormData): Promise<void> {
  return edit(formData, (t) => ({ op: 'restore', slideId: t.slideId }));
}

/** Put a different photograph in this slot, keeping the framing and the hold. */
export async function swapPhotoAction(formData: FormData): Promise<void> {
  const assetId = String(formData.get('assetId') ?? '');
  const t = target(formData);
  await requireOrganizer(t.memorialId);
  const asset = assetFor(db(), t.memorialId, assetId);
  if (!asset) redirect(t.back);

  return edit(formData, (edited) => ({
    op: 'swap',
    slideId: edited.slideId,
    replacement: {
      assetId: asset.id,
      caption: asset.caption,
      suitability: asset.analysis?.slideSuitability ?? null,
      width: asset.width,
      height: asset.height,
    },
  }));
}

/**
 * A photograph this family actually owns.
 *
 * The check is here rather than in the pure edit function on purpose: an asset
 * id arriving in a form post is the one place a slideshow could be made to
 * point at another family's photograph.
 */
function assetFor(database: Db, memorialId: string, assetId: string) {
  const asset = getById(database, mediaAssets, assetId);
  if (!asset || asset.memorialId !== memorialId || asset.deletedAt != null) return undefined;
  return asset;
}
