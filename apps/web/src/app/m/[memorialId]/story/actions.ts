'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { enqueue } from '@col/db';
import { db } from '@/server/db';
import { requireOrganizer } from '@/server/auth';
import { analyzableAssetIds } from './photos';

/**
 * Start photo analysis. Deliberately a button and nothing else.
 *
 * Nothing enqueues this on upload, and nothing enqueues it on a schedule. A
 * family should never discover afterwards that their photographs were sent
 * somewhere; if it happens, it happens because somebody pressed this.
 */
export async function analyzePhotosAction(formData: FormData): Promise<void> {
  const memorialId = String(formData.get('memorialId') ?? '');
  await requireOrganizer(memorialId);

  const assetIds = analyzableAssetIds(db(), memorialId);
  if (assetIds.length > 0) {
    enqueue(db(), { type: 'analyze-photo-batch', memorialId, assetIds }, { memorialId });
  }
  revalidatePath(`/m/${memorialId}/story`);
  redirect(`/m/${memorialId}/story?analysis=started`);
}
