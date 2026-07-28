'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { friendlyAiMessage } from '@col/ai';
import {
  applyAnecdoteAction,
  hasStarted,
  pauseInterview,
  readInterview,
  resumeInterview,
  saveDraft,
  startInterview,
  submitAnswer,
} from '@col/core';
import { db } from '@/server/db';
import { requireOrganizer } from '@/server/auth';

/**
 * The interview's server side.
 *
 * Two rules run through all of it. Every answer is written to its row *before*
 * the model is asked anything, so a provider outage can never cost somebody the
 * paragraph they just typed. And nothing technical ever reaches the screen: an
 * unparseable model response becomes one calm sentence, and the detail goes to
 * the log where it belongs.
 */

/**
 * "Begin" and "Carry on" are the same button, deliberately. Somebody coming
 * back after two days should not have to work out which one they are.
 */
export async function beginInterviewAction(formData: FormData): Promise<void> {
  const memorialId = String(formData.get('memorialId') ?? '');
  const { memorial, participant } = await requireOrganizer(memorialId);
  if (hasStarted(db(), memorialId)) resumeInterview(db(), memorial);
  else startInterview(db(), memorial, { participantId: participant.id });
  redirect(`/m/${memorialId}/interview`);
}

/** Autosave. Called as they type; says nothing but "it is written". */
export async function saveDraftAction(input: {
  memorialId: string;
  sessionId: string;
  text: string;
}): Promise<{ saved: true }> {
  const { memorial } = await requireOrganizer(input.memorialId);
  const state = readInterview(db(), memorial);
  // A stale tab must not write into a session that has moved on.
  if (!state || state.session.id !== input.sessionId) return { saved: true };
  return saveDraft(db(), input.sessionId, input.text);
}

export type AnswerResult =
  { ok: true; question: string; chapters: number } | { ok: false; message: string };

/**
 * Continue, or skip. Both are answers; only one of them has words in it.
 * Returns rather than redirecting so the client can keep the person's text on
 * screen if something goes wrong.
 */
export async function answerAction(input: {
  memorialId: string;
  sessionId: string;
  text: string;
  skipped?: boolean;
}): Promise<AnswerResult> {
  const { memorial } = await requireOrganizer(input.memorialId);
  try {
    const result = await submitAnswer(db(), {
      memorial,
      sessionId: input.sessionId,
      text: input.text,
      ...(input.skipped ? { skipped: true } : {}),
    });
    revalidatePath(`/m/${input.memorialId}/interview`);
    return { ok: true, question: result.question.text, chapters: result.progress.chapters };
  } catch (error) {
    // Their answer is already saved on the turn row; this is only about what
    // happens next.
    // eslint-disable-next-line no-console
    console.error('interview turn failed', error);
    return { ok: false, message: friendlyAiMessage(error) };
  }
}

/** "I'm done for now." Paused, never closed — the question is still waiting. */
export async function pauseInterviewAction(formData: FormData): Promise<void> {
  const memorialId = String(formData.get('memorialId') ?? '');
  const sessionId = String(formData.get('sessionId') ?? '');
  const { memorial } = await requireOrganizer(memorialId);
  const state = readInterview(db(), memorial);
  if (state && state.session.id === sessionId) pauseInterview(db(), sessionId);
  revalidatePath(`/m/${memorialId}`);
  redirect(`/m/${memorialId}/story`);
}

/** Reopening from the story page. */
export async function resumeInterviewAction(formData: FormData): Promise<void> {
  const memorialId = String(formData.get('memorialId') ?? '');
  const { memorial } = await requireOrganizer(memorialId);
  resumeInterview(db(), memorial);
  redirect(`/m/${memorialId}/interview`);
}

/**
 * Approve, edit or remove one anecdote. Each writes a new organizer-authored
 * document version; nothing is ever edited in place.
 */
export async function anecdoteAction(formData: FormData): Promise<void> {
  const memorialId = String(formData.get('memorialId') ?? '');
  const chapterId = String(formData.get('chapterId') ?? '');
  const anecdoteId = String(formData.get('anecdoteId') ?? '');
  const rawAction = String(formData.get('action') ?? '');
  const text = formData.get('text');
  const returnTo = String(formData.get('returnTo') ?? `/m/${memorialId}/interview`);

  const { memorial } = await requireOrganizer(memorialId);
  if (rawAction === 'approve' || rawAction === 'edit' || rawAction === 'remove') {
    applyAnecdoteAction(db(), {
      memorial,
      chapterId,
      anecdoteId,
      action: rawAction,
      ...(text == null ? {} : { text: String(text) }),
    });
  }
  revalidatePath(returnTo);
  redirect(returnTo);
}
