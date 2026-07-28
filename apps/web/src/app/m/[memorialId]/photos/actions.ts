'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  createDelegatedAsk,
  ensureCollectionLink,
  isAskTemplateSlug,
  revokeCollectionLink,
} from '@col/core';
import { db } from '@/server/db';
import { requireOrganizer } from '@/server/auth';

/**
 * Making a personal ask. Everything is optional except a name, because the
 * organiser is filling this in while thinking about who might have the photos
 * from the seventies, and a validation error at that moment is a small cruelty.
 */
export async function createAskAction(formData: FormData): Promise<void> {
  const memorialId = String(formData.get('memorialId') ?? '');
  await requireOrganizer(memorialId);

  const name = String(formData.get('name') ?? '').trim();
  if (!name) redirect(`/m/${memorialId}/photos?ask=name`);

  const rawTemplate = String(formData.get('template') ?? 'anything');
  const template = isAskTemplateSlug(rawTemplate) ? rawTemplate : 'anything';
  const focus = String(formData.get('focus') ?? '').trim() || null;
  const deadline = String(formData.get('deadline') ?? '').trim();
  const deadlineAt = deadline ? Date.parse(`${deadline}T12:00:00Z`) : null;

  const { token } = createDelegatedAsk(db(), {
    memorialId,
    name,
    templateSlug: template,
    focus,
    deadlineAt: Number.isFinite(deadlineAt) ? deadlineAt : null,
  });

  revalidatePath(`/m/${memorialId}/photos`);
  redirect(`/m/${memorialId}/photos?made=${token.id}#links`);
}

/** "This stops the link from working; photos already shared stay." */
export async function revokeLinkAction(formData: FormData): Promise<void> {
  const memorialId = String(formData.get('memorialId') ?? '');
  const tokenId = String(formData.get('tokenId') ?? '');
  await requireOrganizer(memorialId);

  revokeCollectionLink(db(), memorialId, tokenId);
  revalidatePath(`/m/${memorialId}/photos`);
  redirect(`/m/${memorialId}/photos?revoked=1#links`);
}

/** After revoking the family link, there has to be a way to make another one. */
export async function newCollectionLinkAction(formData: FormData): Promise<void> {
  const memorialId = String(formData.get('memorialId') ?? '');
  await requireOrganizer(memorialId);
  ensureCollectionLink(db(), memorialId);
  revalidatePath(`/m/${memorialId}/photos`);
  redirect(`/m/${memorialId}/photos#links`);
}
