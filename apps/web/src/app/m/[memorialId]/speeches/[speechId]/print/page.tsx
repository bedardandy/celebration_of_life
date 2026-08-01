/**
 * The speech, printed, to be read from at a lectern.
 *
 * Large serif, generous leading, one column, and page breaks that never fall in
 * the middle of a paragraph — because the worst possible moment to turn a page
 * is halfway through a sentence about your mother. `[pause]` becomes a line of
 * three quiet dots, which is a stage direction anyone understands at a glance.
 *
 * Nothing on this page is a control. It prints, and that is all it does.
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { isPauseMarker, latestVersion, paragraphsOf, speechTitle } from '@col/core';
import { db } from '@/server/db';
import { requireOrganizer } from '@/server/auth';
import styles from './speech-print.module.css';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'A speech, in large print' };

export default async function SpeechPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ memorialId: string; speechId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { memorialId, speechId } = await params;
  const query = (await searchParams) ?? {};
  const { memorial } = await requireOrganizer(memorialId);

  const variant = query['variant'] === 'graveside' ? 'graveside' : 'full';
  const current = latestVersion(db(), speechId, variant);
  if (!current || current.memorialId !== memorialId) redirect(`/m/${memorialId}/speeches`);

  const paragraphs = paragraphsOf(current.body);
  const backHref = `/m/${memorialId}/speeches/${speechId}${
    variant === 'graveside' ? '?variant=graveside' : ''
  }`;

  return (
    <main className={styles.sheet}>
      <nav className={styles.screenOnly}>
        <Link href={backHref}>Back to the speech</Link>
        <span className={styles.printHint}>
          Print this page. It is set large on purpose — you will be reading it standing up, in a
          room, and probably not at your best.
        </span>
      </nav>

      <header className={styles.header}>
        <p className={styles.eyebrow}>
          {variant === 'graveside' ? 'At the graveside · ' : ''}
          For {memorial.decedentName}
        </p>
        <h1 className={styles.title}>{speechTitle(current)}</h1>
        <p className={styles.meta}>
          {current.speakerName}
          {current.relationship ? `, ${current.relationship}` : ''} · about {current.targetMinutes}{' '}
          minutes
        </p>
      </header>

      {paragraphs.length === 0 ? (
        <p className={styles.paragraph}>There is nothing written in this one yet.</p>
      ) : (
        paragraphs.map((paragraph, index) =>
          isPauseMarker(paragraph) ? (
            <p key={index} className={styles.pause} aria-label="pause">
              · · ·
            </p>
          ) : (
            <p key={index} className={styles.paragraph}>
              {paragraph}
            </p>
          ),
        )
      )}

      <p className={styles.end}>— end —</p>
    </main>
  );
}
