'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  completeIntake,
  isIntakeStep,
  markIntakeStep,
  nextIntakeStep,
  saveGathering,
  saveRelationship,
  saveServiceDate,
  saveTradition,
  type IntakeStep,
} from '@col/core';
import { db } from '@/server/db';
import { requireOrganizer } from '@/server/auth';
import { KEEP } from './keep';

/**
 * Every intake answer is written the moment it is given. There is no Save
 * button anywhere in this wizard, and no draft state that could be lost by
 * closing the tab.
 */
function persist(memorialId: string, stepValue: IntakeStep, value: string | null): void {
  const database = db();
  if (value === KEEP) {
    markIntakeStep(database, memorialId, stepValue);
    return;
  }
  switch (stepValue) {
    case 'relationship':
      saveRelationship(database, memorialId, value);
      return;
    case 'tradition':
      saveTradition(database, memorialId, value);
      return;
    case 'gathering':
      saveGathering(database, memorialId, value);
      return;
    case 'service-date':
      // Reaching here means "Not yet": the date is cleared, deliberately.
      saveServiceDate(database, memorialId, null);
      return;
  }
}

/** Answering (or skipping) a chip question, then moving on. */
export async function answerStepAction(formData: FormData): Promise<void> {
  const memorialId = String(formData.get('memorialId') ?? '');
  const rawStep = String(formData.get('step') ?? '');
  const rawValue = formData.get('value');

  await requireOrganizer(memorialId);
  if (!isIntakeStep(rawStep)) redirect(`/m/${memorialId}`);

  const value = rawValue == null || rawValue === '' ? null : String(rawValue);
  persist(memorialId, rawStep, value);

  const next = nextIntakeStep(rawStep);
  if (!next) {
    completeIntake(db(), memorialId);
    revalidatePath(`/m/${memorialId}`);
    redirect(`/m/${memorialId}`);
  }
  redirect(`/m/${memorialId}/intake/${next}`);
}

/**
 * Autosave for the service-date screen, which has three fields rather than a
 * row of chips. Called on every change; returns nothing but "it is written".
 */
export async function saveServiceDateAction(input: {
  memorialId: string;
  date: string | null;
  time: string | null;
  timezone: string | null;
}): Promise<{ saved: true }> {
  await requireOrganizer(input.memorialId);
  saveServiceDate(db(), input.memorialId, {
    date: input.date,
    time: input.time,
    timezone: input.timezone,
  });
  return { saved: true };
}

/** "Skip the questions for now" — skipping is a real answer, so intake is done. */
export async function skipIntakeAction(formData: FormData): Promise<void> {
  const memorialId = String(formData.get('memorialId') ?? '');
  await requireOrganizer(memorialId);
  completeIntake(db(), memorialId);
  revalidatePath(`/m/${memorialId}`);
  redirect(`/m/${memorialId}`);
}
