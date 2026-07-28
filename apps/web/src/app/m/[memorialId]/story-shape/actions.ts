'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  currentDoc,
  enqueueEdlJob,
  getOrCreateProject,
  saveDocVersion,
  subjectOf,
  type StoryStructure,
} from '@col/core';
import { db } from '@/server/db';
import { requireOrganizer } from '@/server/auth';

const STRUCTURES: StoryStructure[] = ['chrono', 'thematic', 'mixed'];

function structureFrom(formData: FormData): StoryStructure {
  const value = String(formData.get('structure') ?? '');
  return STRUCTURES.includes(value as StoryStructure) ? (value as StoryStructure) : 'mixed';
}

/**
 * The one decision on this screen, made.
 *
 * The choice is written onto the family's own story document rather than into a
 * settings table, because it is a fact about their story and not a preference
 * about our software — and because "put it back in time order" later is then a
 * new version of the document, with the old one still there.
 *
 * Then the job goes on the queue and the person is sent to the preview, which
 * is where the waiting happens. Nobody should sit on a screen watching a
 * spinner that could have been a different screen.
 */
export async function chooseShapeAction(formData: FormData): Promise<void> {
  const memorialId = String(formData.get('memorialId') ?? '');
  const structure = structureFrom(formData);
  const { memorial } = await requireOrganizer(memorialId);

  const { doc } = currentDoc(db(), memorialId, subjectOf(memorial));
  if (doc.structure !== structure) {
    saveDocVersion(db(), memorialId, { ...doc, structure }, 'organizer', 'story shape chosen');
  }

  const project = getOrCreateProject(db(), memorialId);
  enqueueEdlJob(db(), memorialId, project.id, { regenerate: Boolean(project.edl) });

  revalidatePath(`/m/${memorialId}/preview`);
  revalidatePath(`/m/${memorialId}`);
  redirect(`/m/${memorialId}/preview?waiting=1`);
}
