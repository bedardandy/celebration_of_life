import Link from 'next/link';
import { StepScreen, step } from '@/components/StepScreen';
import { DevLinkNote } from '@/components/DevLinkNote';
import { readDevLink } from '@/server/session';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Check your email' };

export default async function ResumeSentPage() {
  const devLink = await readDevLink();
  return (
    <StepScreen
      title="Check your email"
      helper="If we have that address, a link is on its way. It usually arrives within a minute."
      primary={
        <Link className={step.primary} href="/">
          Done
        </Link>
      }
      secondary={
        <Link className={step.quiet} href="/resume">
          Try a different address
        </Link>
      }
      footer="Nothing you have added is lost. The link opens exactly where you left off."
    >
      <DevLinkNote link={devLink} />
    </StepScreen>
  );
}
