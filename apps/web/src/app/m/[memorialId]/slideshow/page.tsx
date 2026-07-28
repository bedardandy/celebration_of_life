/**
 * The slideshow card's destination, which is really a signpost.
 *
 * Where a family lands depends on where they are: a slideshow that already
 * exists means the preview, and one that does not means the single decision
 * that produces it. Nobody should have to work out which screen they want.
 */
import { redirect } from 'next/navigation';
import { latestProject, projectEdl } from '@col/core';
import { db } from '@/server/db';
import { requireOrganizer } from '@/server/auth';

export const dynamic = 'force-dynamic';

export default async function SlideshowPage({
  params,
}: {
  params: Promise<{ memorialId: string }>;
}) {
  const { memorialId } = await params;
  await requireOrganizer(memorialId);

  const project = latestProject(db(), memorialId);
  if (projectEdl(project)) redirect(`/m/${memorialId}/preview`);
  // A project with a job already queued still goes to the preview, which is
  // where the waiting is explained.
  if (project) redirect(`/m/${memorialId}/preview?waiting=1`);
  redirect(`/m/${memorialId}/story-shape`);
}
