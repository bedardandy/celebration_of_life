/**
 * The screen at the venue.
 *
 * Opened on a laptop that is already plugged into the projector, half an hour
 * before people arrive. It plays the *file* — the one ffprobe checked, the one
 * on the USB stick — rather than the live preview, because the file is the
 * artifact of record and a preview that differs from it by one frame is a
 * preview that lied.
 *
 * Organiser only, like every other screen under /m. The video stream is
 * same-origin and session-authorised, so once this page has loaded there is
 * nothing else for it to fetch.
 */
import Link from 'next/link';
import { latestProject, summariseMusic, watchableRender } from '@col/core';
import { StepScreen, step } from '@/components/StepScreen';
import { db } from '@/server/db';
import { requireOrganizer } from '@/server/auth';
import { Stage } from './Stage';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Playing it at the venue' };

export default async function PresentPage({ params }: { params: Promise<{ memorialId: string }> }) {
  const { memorialId } = await params;
  const { memorial } = await requireOrganizer(memorialId);

  const render = watchableRender(db(), memorialId);
  if (!render) {
    return (
      <StepScreen
        eyebrow={`Remembering ${memorial.decedentName}`}
        title="There is no video to play yet"
        helper="This screen plays the finished file. Make it first, and come back."
        primary={
          <Link className={step.primary} href={`/m/${memorialId}/deliver`}>
            Go to the video
          </Link>
        }
        secondary={<Link href={`/m/${memorialId}`}>Back to the dashboard</Link>}
      />
    );
  }

  const music = summariseMusic(db(), latestProject(db(), memorialId));

  return (
    <Stage
      memorialId={memorialId}
      videoSrc={`/api/renders/${render.id}?inline=1`}
      posterSrc={`/api/renders/${render.id}/poster`}
      decedentName={memorial.decedentName}
      soundInFile={music.mode !== 'sideloaded'}
    />
  );
}
