import Link from 'next/link';
import { StepScreen, step } from '@/components/StepScreen';
import { requireOrganizer } from '@/server/auth';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Tell their story' };

export default async function StoryPage({ params }: { params: Promise<{ memorialId: string }> }) {
  const { memorialId } = await params;
  const { memorial } = await requireOrganizer(memorialId);

  return (
    <StepScreen
      eyebrow={`Remembering ${memorial.decedentName}`}
      title="Coming together"
      helper="This is where we will ask you about their life, one question at a time. It opens soon."
      primary={
        <Link className={step.primary} href={`/m/${memorialId}`}>
          Back to the dashboard
        </Link>
      }
      footer="Nothing you do elsewhere is affected by this page not being ready yet."
    />
  );
}
