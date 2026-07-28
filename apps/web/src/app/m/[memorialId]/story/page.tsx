/**
 * The story page.
 *
 * Where the interview lives between sittings: what has been gathered so far,
 * one clear way back in, and the anecdote controls for anyone who would rather
 * read and approve than answer more questions tonight.
 */
import Link from 'next/link';
import {
  currentDoc,
  docProgress,
  hasStarted,
  readInterview,
  shortName,
  storyProgressLine,
  subjectOf,
} from '@col/core';
import { StepScreen, step } from '@/components/StepScreen';
import { db } from '@/server/db';
import { requireOrganizer } from '@/server/auth';
import { StorySoFar } from '../interview/StorySoFar';
import { analyzePhotosAction } from './actions';
import { analyzableAssetIds } from './photos';
import styles from '../interview/interview.module.css';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Tell their story' };

export default async function StoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ memorialId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { memorialId } = await params;
  const query = (await searchParams) ?? {};
  const { memorial } = await requireOrganizer(memorialId);

  const subject = subjectOf(memorial);
  const name = shortName(subject);
  const { doc } = currentDoc(db(), memorialId, subject);
  const progress = docProgress(doc);
  const active = readInterview(db(), memorial);
  const started = hasStarted(db(), memorialId);
  const waiting = analyzableAssetIds(db(), memorialId).length;

  return (
    <StepScreen
      wide
      eyebrow={`Remembering ${memorial.decedentName}`}
      title={started ? `${name}'s story` : `Tell me about ${name}`}
      helper={storyProgressLine(progress, name)}
      primary={
        <Link className={step.primary} href={`/m/${memorialId}/interview`}>
          {active ? 'Carry on' : started ? 'Answer another question' : 'Begin'}
        </Link>
      }
      secondary={
        <Link className={step.quiet} href={`/m/${memorialId}`}>
          Back to the dashboard
        </Link>
      }
      footer="Nothing here is published anywhere. You decide what stays in."
    >
      <StorySoFar
        memorialId={memorialId}
        doc={doc}
        subjectName={name}
        returnTo={`/m/${memorialId}/story`}
        defaultOpen
      />

      <section className={styles.chapter}>
        <h2 className={styles.chapterTitle}>Sorting the photographs</h2>
        {query['analysis'] === 'started' ? (
          <p className={styles.chapterSummary}>
            Started. It runs in the background — you do not need to wait here.
          </p>
        ) : (
          <p className={styles.chapterSummary}>
            {waiting > 0
              ? `We can look through the ${waiting} ${waiting === 1 ? 'photograph' : 'photographs'} you have gathered and ` +
                'suggest which ones carry a full screen, roughly when they were taken, and what is in them. ' +
                'Nothing is sent anywhere until you press this.'
              : 'Once photographs start arriving, we can look through them and suggest an order.'}
          </p>
        )}
        {waiting > 0 && query['analysis'] !== 'started' ? (
          <form action={analyzePhotosAction} className={styles.inlineForm}>
            <input type="hidden" name="memorialId" value={memorialId} />
            <button type="submit" className={step.quiet}>
              Look through the photographs
            </button>
          </form>
        ) : null}
      </section>
    </StepScreen>
  );
}
