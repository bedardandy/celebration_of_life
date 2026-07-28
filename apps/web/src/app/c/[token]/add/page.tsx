import Link from 'next/link';
import { StepScreen, step } from '@/components/StepScreen';
import { currentContributor, resolveToken } from '@/server/contributor';
import { LinkClosed } from '../LinkClosed';
import { UploadArea } from './UploadArea';
import styles from '../contributor.module.css';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Add photos' };

export default async function AddPhotosPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  const query = await searchParams;
  const resolved = resolveToken(token);
  if (!resolved.ok) return <LinkClosed reason={resolved.reason} />;

  const { memorial, ask } = resolved.context;
  const name = memorial.decedentKnownAs || memorial.decedentName;
  const who = await currentContributor(resolved.context);

  return (
    <StepScreen
      eyebrow={`For ${name}`}
      title={who?.displayName ? `Thank you, ${who.displayName}.` : 'Add photos'}
      helper={ask.suggestedCount ? `${ask.body} (${ask.suggestedCount})` : ask.body}
      footer="Photos of printed photos work well — lay them flat, avoid the flash."
      secondary={
        <Link className={step.quiet} href={`/c/${token}/memory`}>
          I would rather write something
        </Link>
      }
    >
      {query['nothing'] ? (
        <p className={styles.notice}>
          Nothing arrived that time. Choosing the photos again usually does it.
        </p>
      ) : null}

      <UploadArea token={token} nextHref={`/c/${token}/notes`} />
    </StepScreen>
  );
}
