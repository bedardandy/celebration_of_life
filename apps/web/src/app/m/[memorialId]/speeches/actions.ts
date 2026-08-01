'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { friendlyAiMessage } from '@col/ai';
import {
  appendVersion,
  buildEulogyContext,
  createSpeech,
  draftEulogy,
  finishSetup,
  fullText,
  isSpeechSetupStep,
  latestVersion,
  nextSpeechSetupStep,
  notesOf,
  pickMemories,
  removeSpeech,
  restoreSpeech,
  restoreVersion,
  reviseEulogy,
  saveEditedBody,
  saveSetup,
  selectableMemories,
  REVISION_LABELS,
  type SpeechSetupStep,
} from '@col/core';
import { EulogyNotesSchema, type EulogyTone, type EulogyVariant } from '@col/schemas';
import type { EulogyRevision } from '@col/ai';
import { db } from '@/server/db';
import { requireOrganizer } from '@/server/auth';

/**
 * The eulogy studio's server side.
 *
 * Two rules run through all of it, the same two the interview follows. Words a
 * person typed are written before anything else happens, so a provider outage
 * can never cost somebody their evening. And every model call that succeeds
 * appends a version rather than replacing one — the previous draft is always
 * one click away, which is what makes the tool buttons safe to press.
 */

const TONES: EulogyTone[] = ['warm-with-laughter', 'quiet-and-simple', 'faithful'];

/** The speech, checked against the memorial in the URL rather than trusted. */
async function loadSpeech(memorialId: string, speechId: string, variant: EulogyVariant = 'full') {
  const { memorial } = await requireOrganizer(memorialId);
  const current = latestVersion(db(), speechId, variant);
  if (!current || current.memorialId !== memorialId) redirect(`/m/${memorialId}/speeches`);
  return { memorial, current };
}

/** "Start a speech" — the row exists before the first question is asked. */
export async function startSpeechAction(formData: FormData): Promise<void> {
  const memorialId = String(formData.get('memorialId') ?? '');
  const { participant } = await requireOrganizer(memorialId);
  const speech = createSpeech(db(), {
    memorialId,
    // The organiser is usually the first speaker, so their name is offered
    // rather than an empty box. It is editable on the very next screen.
    ...(participant.displayName ? { speakerName: participant.displayName } : {}),
  });
  revalidatePath(`/m/${memorialId}/speeches`);
  redirect(`/m/${memorialId}/speeches/${speech.speechId}/setup/speaker`);
}

/**
 * One setup answer, then the next screen. Skipping is a real answer here too:
 * an empty value simply moves on with whatever the defaults are.
 */
export async function saveSetupStepAction(formData: FormData): Promise<void> {
  const memorialId = String(formData.get('memorialId') ?? '');
  const speechId = String(formData.get('speechId') ?? '');
  const rawStep = String(formData.get('step') ?? '');
  await loadSpeech(memorialId, speechId);
  if (!isSpeechSetupStep(rawStep)) redirect(`/m/${memorialId}/speeches/${speechId}`);
  const step = rawStep as SpeechSetupStep;

  if (step === 'speaker') {
    const speakerName = String(formData.get('speakerName') ?? '').trim();
    const relationship = String(formData.get('relationship') ?? '').trim();
    saveSetup(db(), speechId, { speakerName, relationship: relationship || null });
  }

  if (step === 'length') {
    const minutes = Number.parseInt(String(formData.get('targetMinutes') ?? ''), 10);
    if (Number.isFinite(minutes) && minutes > 0) {
      saveSetup(db(), speechId, { targetMinutes: minutes });
    }
  }

  if (step === 'tone') {
    const tone = String(formData.get('tone') ?? '');
    if (TONES.includes(tone as EulogyTone)) saveSetup(db(), speechId, { tone: tone as EulogyTone });
  }

  if (step === 'memories') {
    const selected = formData.getAll('memoryId').map((value) => String(value));
    saveSetup(db(), speechId, { selectedMemoryIds: selected });
  }

  const next = nextSpeechSetupStep(step);
  // The last answer closes the wizard, so coming back later opens the studio
  // rather than the questions all over again.
  if (!next) finishSetup(db(), speechId);
  revalidatePath(`/m/${memorialId}/speeches/${speechId}`);
  redirect(
    next
      ? `/m/${memorialId}/speeches/${speechId}/setup/${next}`
      : `/m/${memorialId}/speeches/${speechId}`,
  );
}

export type SpeechActionResult = { ok: true } | { ok: false; message: string };

/**
 * The first draft.
 *
 * Returns rather than redirects, so a failed call leaves the person exactly
 * where they were with one calm sentence — never a blank page, and never a
 * setup they have to answer again.
 */
export async function draftSpeechAction(input: {
  memorialId: string;
  speechId: string;
}): Promise<SpeechActionResult> {
  const { memorial, current } = await loadSpeech(input.memorialId, input.speechId);
  const notes = notesOf(current);
  const memories = pickMemories(selectableMemories(db(), memorial), notes.selectedMemoryIds);

  try {
    const drafted = await draftEulogy(
      buildEulogyContext(db(), memorial, {
        speakerName: current.speakerName,
        relationship: current.relationship,
        targetMinutes: current.targetMinutes,
        tone: current.tone,
        memories,
      }),
    );
    appendVersion(db(), {
      speechId: input.speechId,
      from: current,
      body: fullText(drafted),
      notes: EulogyNotesSchema.parse({
        ...notes,
        openingLine: drafted.openingLine,
        closingLine: drafted.closingLine,
        usedMemoryIds: drafted.usedMemoryIds,
        warnings: drafted.warnings,
        wordCount: drafted.wordCount,
      }),
      createdBy: 'ai',
      note: 'First draft',
      status: 'draft',
    });
    revalidatePath(`/m/${input.memorialId}/speeches/${input.speechId}`);
    return { ok: true };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('eulogy draft failed', error);
    return { ok: false, message: friendlyAiMessage(error) };
  }
}

/** Shorter, longer, warmer, simpler — and the graveside version. */
export async function reviseSpeechAction(input: {
  memorialId: string;
  speechId: string;
  revision: EulogyRevision;
  /** Which text is being changed: the speech, or its graveside form. */
  variant?: EulogyVariant;
}): Promise<SpeechActionResult> {
  const label = REVISION_LABELS[input.revision];
  if (!label) return { ok: false, message: 'That is not something we can do to a speech.' };

  const { memorial, current } = await loadSpeech(
    input.memorialId,
    input.speechId,
    input.variant ?? 'full',
  );
  const notes = notesOf(current);
  const memories = pickMemories(selectableMemories(db(), memorial), notes.selectedMemoryIds);

  try {
    const revised = await reviseEulogy({
      revision: input.revision,
      currentBody: current.body,
      memories,
      targetMinutes: current.targetMinutes,
      speakerName: current.speakerName,
    });
    appendVersion(db(), {
      speechId: input.speechId,
      from: current,
      body: fullText(revised),
      notes: EulogyNotesSchema.parse({
        ...notes,
        openingLine: revised.openingLine,
        closingLine: revised.closingLine,
        usedMemoryIds: revised.usedMemoryIds,
        warnings: revised.warnings,
        wordCount: revised.wordCount,
      }),
      createdBy: 'ai',
      note: label.note,
      status: 'draft',
      // "Make a graveside version" produces the short form; every other tool
      // stays on whichever text is currently on screen.
      variant: label.variant ?? input.variant ?? 'full',
    });
    revalidatePath(`/m/${input.memorialId}/speeches/${input.speechId}`);
    return { ok: true };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('eulogy revision failed', error);
    return { ok: false, message: friendlyAiMessage(error) };
  }
}

/** Autosave. Called as they type; says nothing but "it is written". */
export async function saveSpeechBodyAction(input: {
  memorialId: string;
  speechId: string;
  body: string;
  variant?: EulogyVariant;
}): Promise<{ saved: true }> {
  await loadSpeech(input.memorialId, input.speechId, input.variant ?? 'full');
  saveEditedBody(db(), input.speechId, input.body, input.variant ?? 'full');
  return { saved: true };
}

/** Going back to an earlier version — itself a new version, so nothing is lost. */
export async function restoreVersionAction(formData: FormData): Promise<void> {
  const memorialId = String(formData.get('memorialId') ?? '');
  const speechId = String(formData.get('speechId') ?? '');
  const versionId = String(formData.get('versionId') ?? '');
  await loadSpeech(memorialId, speechId);
  restoreVersion(db(), versionId);
  revalidatePath(`/m/${memorialId}/speeches/${speechId}`);
  redirect(`/m/${memorialId}/speeches/${speechId}`);
}

export async function removeSpeechAction(
  memorialId: string,
  speechId: string,
): Promise<{ message: string }> {
  await loadSpeech(memorialId, speechId);
  removeSpeech(db(), speechId);
  revalidatePath(`/m/${memorialId}/speeches`);
  return { message: 'That speech has been removed.' };
}

export async function restoreSpeechAction(
  memorialId: string,
  speechId: string,
): Promise<{ restored: boolean }> {
  await requireOrganizer(memorialId);
  const restored = restoreSpeech(db(), speechId) > 0;
  revalidatePath(`/m/${memorialId}/speeches`);
  return { restored };
}
