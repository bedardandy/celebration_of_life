'use server';

import { redirect } from 'next/navigation';
import { deliverEmail, requestLoginLink } from '@col/core';
import { db } from '@/server/db';
import { stashDevLink } from '@/server/session';

export type ResumeState = { error?: string; email?: string };

/**
 * "I already have one."
 *
 * The reply is the same sentence whether or not we recognise the address: this
 * app must not be a way to find out whose family is grieving.
 */
export async function requestLinkAction(
  _previous: ResumeState,
  formData: FormData,
): Promise<ResumeState> {
  const email = String(formData.get('email') ?? '');
  const result = requestLoginLink(db(), email);

  if (!result.accepted) {
    return { error: 'Please check the email address.', email };
  }

  if (result.issued && result.memorial) {
    const sent = await deliverEmail(db(), {
      template: 'organizer-login',
      to: result.organizer?.email ?? email,
      memorialId: result.memorial.id,
      data: { decedentName: result.memorial.decedentName, url: result.issued.url },
    });
    await stashDevLink(sent.devPreviewLink);
  }

  redirect('/resume/sent');
}
