import Link from 'next/link';
import { INTAKE_STEPS } from '@col/core';
import { StepScreen, step } from '@/components/StepScreen';
import { DevLinkNote } from '@/components/DevLinkNote';
import { requireOrganizer } from '@/server/auth';
import { readDevLink } from '@/server/session';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Your link' };

export default async function CreatedPage({ params }: { params: Promise<{ memorialId: string }> }) {
  const { memorialId } = await params;
  const { memorial, participant } = await requireOrganizer(memorialId);
  const devLink = await readDevLink();

  return (
    <StepScreen
      eyebrow={`Remembering ${memorial.decedentName}`}
      title="You are all set."
      helper={
        participant.email
          ? `We sent a link to ${participant.email}. It brings you straight back here, whenever you need it.`
          : 'We have kept your place. You can come back to this page whenever you need it.'
      }
      primary={
        <Link className={step.primary} href={`/m/${memorialId}/intake/${INTAKE_STEPS[0]}`}>
          Continue
        </Link>
      }
      secondary={
        <Link className={step.quiet} href={`/m/${memorialId}`}>
          Skip the questions for now
        </Link>
      }
      footer="Next we ask four short questions. Every one of them can be skipped."
    >
      <DevLinkNote link={devLink} />
    </StepScreen>
  );
}
