'use server';

import { redirect } from 'next/navigation';
import { InvalidMemorialInput, createMemorial, deliverEmail } from '@col/core';
import { db } from '@/server/db';
import { stashDevLink, writeSession } from '@/server/session';

export type CreateMemorialState = {
  error?: string;
  /** Which field to put the cursor back in. */
  field?: 'decedentName' | 'organizerName' | 'organizerEmail';
  values?: { decedentName: string; organizerName: string; organizerEmail: string };
};

/**
 * Creates the memorial and signs the organiser straight in.
 *
 * The link still goes to their inbox — that is how they get back tomorrow — but
 * making someone check their email before they can carry on, on the day
 * somebody died, would be unkind.
 */
export async function createMemorialAction(
  _previous: CreateMemorialState,
  formData: FormData,
): Promise<CreateMemorialState> {
  const values = {
    decedentName: String(formData.get('decedentName') ?? ''),
    organizerName: String(formData.get('organizerName') ?? ''),
    organizerEmail: String(formData.get('organizerEmail') ?? ''),
  };

  let created;
  try {
    created = createMemorial(db(), values);
  } catch (error) {
    if (error instanceof InvalidMemorialInput) {
      return { error: error.message, field: error.field, values };
    }
    throw error;
  }

  const sent = await deliverEmail(db(), {
    template: 'organizer-login',
    to: created.organizer.email as string,
    memorialId: created.memorial.id,
    data: { decedentName: created.memorial.decedentName, url: created.login.url },
  });

  await writeSession({
    participantId: created.organizer.id,
    memorialId: created.memorial.id,
    role: 'organizer',
    issuedAt: Date.now(),
  });
  await stashDevLink(sent.devPreviewLink);

  redirect(`/m/${created.memorial.id}/created`);
}
