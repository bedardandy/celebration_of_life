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
import { getOrCreateProject, projectEdl, requestRender } from '@col/core';
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
