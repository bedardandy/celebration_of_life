'use server';

/**
 * Taking the offer up.
 *
 * The link is re-checked here, not trusted from the page that rendered the
 * form: a link turned off in the meantime stops working at this tap, which is
 * what "turn this link off" has to mean.
 *
 * What comes out is the same session an emailed login link produces — same
 * cookie, same scope, same memorial — because a co-organiser is an organiser,
 * not a lesser kind of one.
 */
import { redirect } from 'next/navigation';
import { acceptCoOrganizerInvite, looksLikeEmail } from '@col/core';
import { db } from '@/server/db';
import { writeSession } from '@/server/session';

export async function joinAsCoOrganizerAction(formData: FormData): Promise<void> {
  const token = String(formData.get('token') ?? '');
  const firstName = String(formData.get('name') ?? '');
  const email = String(formData.get('email') ?? '');

  if (!looksLikeEmail(email)) redirect(`/join/${token}?check=email`);
  if (!firstName.trim()) redirect(`/join/${token}?check=name`);

  const now = Date.now();
  const result = acceptCoOrganizerInvite(db(), { token, firstName, email, now });
  if (!result.ok) redirect(`/join/${token}`);

  await writeSession({
    participantId: result.participant.id,
    memorialId: result.memorial.id,
    role: 'organizer',
    issuedAt: now,
  });

  redirect(`/m/${result.memorial.id}`);
}
