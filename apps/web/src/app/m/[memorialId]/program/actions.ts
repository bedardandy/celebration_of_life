'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { friendlyAiMessage } from '@col/ai';
import {
  addOrderItem,
  currentProgram,
  draftLifeSketch,
  isProgramStep,
  moveOrderItem,
  nextProgramStep,
  readingSuggestions,
  removeOrderItem,
  renameOrderItem,
  saveOrganizerEdit,
  saveProgramVersion,
  type ProgramStep,
} from '@col/core';
import type { ProgramDocument } from '@col/schemas';
import { db } from '@/server/db';
import { requireOrganizer } from '@/server/auth';

/**
 * The program's server side.
 *
 * Every change is written the moment it is made — there is no Save button on
 * any of these screens — and the document is versioned, so three people
 * arguing about the wording of an acknowledgement can always get back to what
 * it said before.
 */

function stepPath(memorialId: string, step: ProgramStep | undefined): string {
  return step ? `/m/${memorialId}/program/${step}` : `/m/${memorialId}/program`;
}

/** The cover photograph, chosen from the ones the family already approved. */
export async function saveCoverAction(formData: FormData): Promise<void> {
  const memorialId = String(formData.get('memorialId') ?? '');
  const assetId = String(formData.get('assetId') ?? '').trim();
  const { memorial } = await requireOrganizer(memorialId);
  const { doc } = currentProgram(db(), memorial);

  const next: ProgramDocument = { ...doc };
  if (assetId) next.coverAssetId = assetId;
  else delete next.coverAssetId;
  saveOrganizerEdit(db(), memorialId, next, 'Chose the cover photograph');

  revalidatePath(`/m/${memorialId}/program`);
  redirect(stepPath(memorialId, nextProgramStep('cover')));
}

/** Add, rename, remove or move one line of the order of service. */
export async function orderItemAction(formData: FormData): Promise<void> {
  const memorialId = String(formData.get('memorialId') ?? '');
  const op = String(formData.get('op') ?? '');
  const index = Number.parseInt(String(formData.get('index') ?? '-1'), 10);
  const item = String(formData.get('item') ?? '');
  const note = String(formData.get('note') ?? '');

  const { memorial } = await requireOrganizer(memorialId);
  const { doc } = currentProgram(db(), memorial);

  const next =
    op === 'add'
      ? addOrderItem(doc, item, note)
      : op === 'rename'
        ? renameOrderItem(doc, index, item, note)
        : op === 'remove'
          ? removeOrderItem(doc, index)
          : op === 'up'
            ? moveOrderItem(doc, index, -1)
            : op === 'down'
              ? moveOrderItem(doc, index, 1)
              : doc;

  if (next !== doc) saveOrganizerEdit(db(), memorialId, next, 'Changed the order of service');
  revalidatePath(`/m/${memorialId}/program/order`);
  redirect(stepPath(memorialId, 'order'));
}

/** Autosave for the life sketch. Says nothing but "it is written". */
export async function saveSketchAction(input: {
  memorialId: string;
  text: string;
}): Promise<{ saved: true }> {
  const { memorial } = await requireOrganizer(input.memorialId);
  const { doc } = currentProgram(db(), memorial);
  saveOrganizerEdit(
    db(),
    input.memorialId,
    { ...doc, lifeSketch: input.text },
    'Wrote the life sketch',
  );
  return { saved: true };
}

export type ProgramActionResult = { ok: true } | { ok: false; message: string };

/**
 * Draft the life sketch from the story the family has already written.
 *
 * Returns rather than redirects, so a failed call leaves the words that are
 * already in the box exactly where they are.
 */
export async function draftSketchAction(input: {
  memorialId: string;
}): Promise<ProgramActionResult> {
  const { memorial } = await requireOrganizer(input.memorialId);
  try {
    const sketch = await draftLifeSketch(db(), memorial);
    const { doc } = currentProgram(db(), memorial);
    saveProgramVersion(
      db(),
      input.memorialId,
      { ...doc, lifeSketch: sketch.text },
      'ai',
      'Drafted from their story',
    );
    revalidatePath(`/m/${input.memorialId}/program/sketch`);
    return { ok: true };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('life sketch draft failed', error);
    return { ok: false, message: friendlyAiMessage(error) };
  }
}

/** A reading: one of the tradition's suggestions, the family's own, or none. */
export async function saveReadingAction(formData: FormData): Promise<void> {
  const memorialId = String(formData.get('memorialId') ?? '');
  const choice = String(formData.get('choice') ?? '');
  const { memorial } = await requireOrganizer(memorialId);
  const { doc } = currentProgram(db(), memorial);
  const next: ProgramDocument = { ...doc };

  if (choice === 'none') {
    delete next.reading;
  } else if (choice === 'own') {
    const title = String(formData.get('title') ?? '').trim();
    const text = String(formData.get('text') ?? '').trim();
    const source = String(formData.get('source') ?? '').trim();
    if (title) {
      next.reading = {
        title: title.slice(0, 160),
        ...(text ? { text: text.slice(0, 4000) } : {}),
        source: (source || 'Chosen by the family').slice(0, 300),
      };
    }
  } else {
    const suggestions = readingSuggestions(memorial.traditionSlug);
    const chosen = suggestions[Number.parseInt(choice, 10)];
    if (chosen) next.reading = chosen;
  }

  saveOrganizerEdit(db(), memorialId, next, 'Chose a reading');
  revalidatePath(`/m/${memorialId}/program`);
  redirect(stepPath(memorialId, nextProgramStep('reading')));
}

/** The acknowledgement, and anything for the back page. */
export async function saveThanksAction(formData: FormData): Promise<void> {
  const memorialId = String(formData.get('memorialId') ?? '');
  const acknowledgments = String(formData.get('acknowledgments') ?? '').trim();
  const backNote = String(formData.get('backNote') ?? '').trim();
  const { memorial } = await requireOrganizer(memorialId);
  const { doc } = currentProgram(db(), memorial);

  saveOrganizerEdit(
    db(),
    memorialId,
    { ...doc, acknowledgments, backNote },
    'Wrote the acknowledgement',
  );
  revalidatePath(`/m/${memorialId}/program`);
  redirect(`/m/${memorialId}/program`);
}

/** "Continue" on a screen that has already autosaved everything it holds. */
export async function continueProgramAction(formData: FormData): Promise<void> {
  const memorialId = String(formData.get('memorialId') ?? '');
  const rawStep = String(formData.get('step') ?? '');
  await requireOrganizer(memorialId);
  if (!isProgramStep(rawStep)) redirect(`/m/${memorialId}/program`);
  redirect(stepPath(memorialId, nextProgramStep(rawStep)));
}
