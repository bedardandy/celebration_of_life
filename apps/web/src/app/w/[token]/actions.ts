'use server';

/**
 * A thought, sent back to the family.
 *
 * The viewing link is the whole credential here, exactly as it is for the video
 * itself, so the action re-resolves it before writing anything: a link turned
 * off while somebody had the page open stops working at the next tap, and the
 * person is shown the same gentle closed page rather than an error.
 *
 * Nothing here can reach another family's memorial, because nothing here takes
 * a memorial id from the browser — it comes from the token.
 */
import { redirect } from 'next/navigation';
import { addReviewNote, resolveWatchToken, watchableRender } from '@col/core';
import { db } from '@/server/db';

export async function leaveNoteAction(formData: FormData): Promise<void> {
  const token = String(formData.get('token') ?? '');
  const resolved = resolveWatchToken(db(), token);
  if (!resolved.ok) redirect(`/w/${token}`);

  const body = String(formData.get('note') ?? '');
  if (!body.trim()) redirect(`/w/${token}`);

  const render = resolved.context.render ?? watchableRender(db(), resolved.context.memorial.id);
  const rawTimecode = String(formData.get('timecodeMs') ?? '').trim();
  const timecodeMs = /^\d+$/.test(rawTimecode) ? Number(rawTimecode) : null;

  addReviewNote(db(), {
    memorialId: resolved.context.memorial.id,
    body,
    authorName: String(formData.get('name') ?? ''),
    renderJobId: render?.id ?? null,
    timecodeMs,
    createdVia: 'watch',
  });

  redirect(`/w/${token}?sent=1#note`);
}
