/**
 * Music, not yet.
 *
 * A placeholder, but not a dead end: it says plainly what is coming, and it
 * puts the two things a family can actually do right now in front of them. An
 * empty "coming soon" page at this point in a week is a small abandonment.
 */
import Link from 'next/link';
import { StepScreen, step } from '@/components/StepScreen';
import { requireOrganizer } from '@/server/auth';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Music' };

export default async function MusicPage({ params }: { params: Promise<{ memorialId: string }> }) {
  const { memorialId } = await params;
  const { memorial } = await requireOrganizer(memorialId);

  return (
    <StepScreen
      eyebrow={`Remembering ${memorial.decedentName}`}
      title="Music comes next"
      helper="This part of the toolkit opens soon. Nothing you have done so far is waiting on it."
      primary={
        <Link className={step.primary} href={`/m/${memorialId}/preview`}>
          Back to the slideshow
        </Link>
      }
      secondary={<Link href={`/m/${memorialId}`}>Back to the dashboard</Link>}
      footer="When it does open, you will be able to choose a cleared track we can include in the file, or keep the video silent and have the venue play the song you have in mind."
    />
  );
}
