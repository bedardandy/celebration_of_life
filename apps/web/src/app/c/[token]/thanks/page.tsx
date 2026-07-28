import Link from 'next/link';
import { StepScreen, step } from '@/components/StepScreen';
import { resolveToken } from '@/server/contributor';
import { LinkClosed } from '../LinkClosed';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Thank you' };

export default async function ThanksPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const resolved = resolveToken(token);
  if (!resolved.ok) return <LinkClosed reason={resolved.reason} />;

  const { memorial } = resolved.context;
  const name = memorial.decedentKnownAs || memorial.decedentName;

  return (
    <StepScreen
      eyebrow={`For ${name}`}
      title="Thank you."
      helper="You can come back and add more any time — this link keeps working."
      primary={
        <Link className={step.primary} href={`/c/${token}/add`}>
          Add more photos
        </Link>
      }
      footer="If something turns up in a drawer next week, this is where it goes."
    />
  );
}
