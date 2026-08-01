'use server';

/**
 * Asking for the video.
 *
 * Two buttons on the screen and one of them is the real one. Both land here,
 * both enqueue durable work, and both return immediately — the family is never
 * holding a request open while a video renders.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  createWatchLink,
  getOrCreateProject,
  projectEdl,
  requestRender,
  revokeWatchLink,
  setWatchDownload,
} from '@col/core';
import type { CutName, RenderPreset } from '@col/schemas';
import { db } from '@/server/db';
import { requireOrganizer } from '@/server/auth';

const CUTS: CutName[] = ['service', 'family'];
const PRESETS: RenderPreset[] = ['draft360', 'final1080', 'backup720'];

function cutFrom(formData: FormData): CutName {
  const value = String(formData.get('cut') ?? '');
  return CUTS.includes(value as CutName) ? (value as CutName) : 'service';
}

/**
 * Make the video.
 *
 * The backup 720p copy is a second render rather than a transcode of the first,
 * because it is queued alongside and finishes not long after — and because a
 * transcode of a transcode is how a video ends up looking like a video of a
 * video.
 */
export async function startRenderAction(formData: FormData): Promise<void> {
  const memorialId = String(formData.get('memorialId') ?? '');
  const preset = String(formData.get('preset') ?? '');
  const cut = cutFrom(formData);
  const wantsBackup = formData.get('backup') != null;
  await requireOrganizer(memorialId);

  const project = getOrCreateProject(db(), memorialId);
  if (!projectEdl(project)) {
    redirect(`/m/${memorialId}/preview?waiting=1`);
  }

  const chosen = PRESETS.includes(preset as RenderPreset) ? (preset as RenderPreset) : 'final1080';
  requestRender(db(), { memorialId, projectId: project.id, cut, preset: chosen });

  if (chosen === 'final1080' && wantsBackup) {
    requestRender(db(), { memorialId, projectId: project.id, cut, preset: 'backup720' });
  }

  revalidatePath(`/m/${memorialId}/deliver`);
  revalidatePath(`/m/${memorialId}`);
  redirect(`/m/${memorialId}/deliver?cut=${cut}&started=1`);
}

/* -------------------------------------------------------------------------- */
/* private viewing links                                                       */
/* -------------------------------------------------------------------------- */

/**
 * "Share a private viewing link."
 *
 * Not everyone can be in the room. This makes a link the family can text to a
 * brother in another country — no account, no app, and off again in one press.
 * Saving a copy is a separate decision, and it starts off.
 */
export async function createWatchLinkAction(formData: FormData): Promise<void> {
  const memorialId = String(formData.get('memorialId') ?? '');
  await requireOrganizer(memorialId);

  createWatchLink(db(), { memorialId });

  revalidatePath(`/m/${memorialId}/deliver`);
  redirect(`/m/${memorialId}/deliver?shared=1#watch`);
}

export async function revokeWatchLinkAction(formData: FormData): Promise<void> {
  const memorialId = String(formData.get('memorialId') ?? '');
  const tokenId = String(formData.get('tokenId') ?? '');
  await requireOrganizer(memorialId);

  revokeWatchLink(db(), memorialId, tokenId);

  revalidatePath(`/m/${memorialId}/deliver`);
  redirect(`/m/${memorialId}/deliver?watchoff=1#watch`);
}

/** Whether people who have the link may also keep a copy of the file. */
export async function setWatchDownloadAction(formData: FormData): Promise<void> {
  const memorialId = String(formData.get('memorialId') ?? '');
  const tokenId = String(formData.get('tokenId') ?? '');
  const allow = String(formData.get('allow') ?? '') === 'yes';
  await requireOrganizer(memorialId);

  setWatchDownload(db(), memorialId, tokenId, allow);

  revalidatePath(`/m/${memorialId}/deliver`);
  redirect(`/m/${memorialId}/deliver#watch`);
}
