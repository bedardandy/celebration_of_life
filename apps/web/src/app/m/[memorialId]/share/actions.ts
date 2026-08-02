'use server';

/**
 * Handing somebody else the same job.
 *
 * One link, made deliberately, shown once and shown again next Thursday. It is
 * the organiser's own access, so the screen around it is blunt about that and
 * the link can be turned off in one press.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createCoOrganizerInvite, revokeCoOrganizerInvite } from '@col/core';
import { db } from '@/server/db';
import { requireOrganizer } from '@/server/auth';

export async function createInviteAction(formData: FormData): Promise<void> {
  const memorialId = String(formData.get('memorialId') ?? '');
  await requireOrganizer(memorialId);

  createCoOrganizerInvite(db(), memorialId);

  revalidatePath(`/m/${memorialId}/share`);
  redirect(`/m/${memorialId}/share?made=1`);
}

export async function revokeInviteAction(formData: FormData): Promise<void> {
  const memorialId = String(formData.get('memorialId') ?? '');
  const tokenId = String(formData.get('tokenId') ?? '');
  await requireOrganizer(memorialId);

  revokeCoOrganizerInvite(db(), memorialId, tokenId);

  revalidatePath(`/m/${memorialId}/share`);
  redirect(`/m/${memorialId}/share?off=1`);
}
