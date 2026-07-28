'use server';

import { redirect } from 'next/navigation';
import {
  addPhotoNote,
  joinAsContributor,
  UNFORGETTABLE_PROMPT_SLUG,
  type ContributorContext,
} from '@col/core';
import { db } from '@/server/db';
import { clearBatch, currentContributor, readBatch, rememberContributor, resolveToken } from '@/server/contributor';

/**
 * Every action here starts by re-resolving the link. The URL is the credential,
 * so it is checked on the way in *and* on the way out — a link revoked while a
 * contributor had the page open stops working at the next tap, which is what
 * "this stops the link from working" has to mean.
 */
async function withToken(token: string): Promise<ContributorContext> {
  const resolved = resolveToken(token);
  if (!resolved.ok) redirect(`/c/${token}`);
  return resolved.context;
}

/** "What should we call you?" — the only question asked before helping. */
export async function saveNameAction(formData: FormData): Promise<void> {
  const token = String(formData.get('token') ?? '');
  const name = String(formData.get('name') ?? '');
  const context = await withToken(token);

  const participant = joinAsContributor(db(), context, name);
  await rememberContributor(context.token.id, participant.id);
  redirect(`/c/${token}/add`);
}

/**
 * Notes about the photos that just arrived. Every field is optional and the
 * whole screen is skippable in one tap; a photo with no note is not a failure.
 */
export async function saveNotesAction(formData: FormData): Promise<void> {
  const token = String(formData.get('token') ?? '');
  const context = await withToken(token);
  const participant = await currentContributor(context);
  const batch = await readBatch(context.token.id);

  for (const assetId of batch) {
    const text = String(formData.get(`note-${assetId}`) ?? '').trim();
    if (!text) continue;
    addPhotoNote(db(), {
      memorialId: context.memorial.id,
      assetId,
      participantId: participant?.id ?? null,
      authorName: participant?.displayName ?? null,
      promptSlug: 'photo-context',
      text,
    });
  }

  redirect(`/c/${token}/memory`);
}

/** The one memory prompt, at the end, asked once. */
export async function saveMemoryAction(formData: FormData): Promise<void> {
  const token = String(formData.get('token') ?? '');
  const text = String(formData.get('memory') ?? '').trim();
  const context = await withToken(token);
  const participant = await currentContributor(context);

  if (text) {
    addPhotoNote(db(), {
      memorialId: context.memorial.id,
      participantId: participant?.id ?? null,
      authorName: participant?.displayName ?? null,
      promptSlug: UNFORGETTABLE_PROMPT_SLUG,
      text,
    });
  }

  await clearBatch(context.token.id);
  redirect(`/c/${token}/thanks`);
}

/** Skipping is a real answer here too: it clears the batch and thanks them. */
export async function skipToThanksAction(formData: FormData): Promise<void> {
  const token = String(formData.get('token') ?? '');
  const context = await withToken(token);
  await clearBatch(context.token.id);
  redirect(`/c/${token}/thanks`);
}
