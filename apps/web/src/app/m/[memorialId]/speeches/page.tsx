/**
 * The speeches page.
 *
 * A funeral usually has more than one person speaking, and each of them wants
 * their own draft, their own length and their own memories. So this is a list
 * rather than a single document — "Anne's words", "Reading for the graveside" —
 * with one way in and one way to start another.
 *
 * The printed program lives here too, because in a family's head "who is
 * speaking" and "what do we hand out" are the same afternoon's work.
 */
import Link from 'next/link';
import {
  currentProgram,
  describeSpeechLength,
  hasProgram,
  listSpeeches,
  programProgress,
  speechTitle,
  type SpeechSummary,
} from '@col/core';
import { StepScreen, step } from '@/components/StepScreen';
import { db } from '@/server/db';
import { requireOrganizer } from '@/server/auth';
import { startSpeechAction } from './actions';
import styles from './speeches.module.css';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Speeches & program' };

export default async function SpeechesPage({
  params,
}: {
  params: Promise<{ memorialId: string }>;
}) {
  const { memorialId } = await params;
  const { memorial } = await requireOrganizer(memorialId);

  const speeches = listSpeeches(db(), memorialId);
  const program = currentProgram(db(), memorial);
  const progress = programProgress(program.doc);
  const started = hasProgram(db(), memorialId);

  return (
    <StepScreen
      wide
      eyebrow={`Remembering ${memorial.decedentName}`}
      title="Speeches & program"
      helper="What people will say on the day, and the program you hand out at the door."
      primary={
        <form action={startSpeechAction}>
          <input type="hidden" name="memorialId" value={memorialId} />
          <button type="submit" className={step.primary}>
            {speeches.length === 0 ? 'Start a speech' : 'Start another speech'}
          </button>
        </form>
      }
      secondary={
        <Link className={step.quiet} href={`/m/${memorialId}`}>
          Back to the dashboard
        </Link>
      }
      footer="Everything here saves as you go, and every draft can be taken back a step."
    >
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>The speeches</h2>
        {speeches.length === 0 ? (
          <p className={styles.empty}>
            Nothing here yet. We can put together a first draft in your voice, built out of the
            memories you have already kept — you rewrite it from there, and no one will ever know
            how it started.
          </p>
        ) : (
          <ul className={styles.list}>
            {speeches.map((speech) => (
              <li key={speech.speechId}>
                <SpeechRow memorialId={memorialId} speech={speech} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>The printed program</h2>
        <p className={styles.programLine}>{progress.line}</p>
        <p className={styles.programLinks}>
          <Link className={step.quiet} href={`/m/${memorialId}/program`}>
            {started ? 'Carry on with the program' : 'Start the program'}
          </Link>
          {started ? (
            <Link className={step.quiet} href={`/m/${memorialId}/program/print`}>
              See it as it will print
            </Link>
          ) : null}
        </p>
      </section>
    </StepScreen>
  );
}

function SpeechRow({ memorialId, speech }: { memorialId: string; speech: SpeechSummary }) {
  const current = speech.current;
  const written = current.body.trim().length > 0;
  const href = `/m/${memorialId}/speeches/${speech.speechId}`;

  return (
    <Link className={styles.card} href={href}>
      <span className={styles.cardTitle}>{speechTitle(current)}</span>
      <span className={styles.cardMeta}>
        {current.relationship ? `${current.relationship} · ` : ''}
        {written
          ? `${describeSpeechLength(current.body)} · ${speech.versionCount} ${
              speech.versionCount === 1 ? 'version' : 'versions'
            }`
          : `aiming for ${current.targetMinutes} minutes`}
      </span>
      <span className={styles.cardStatus}>
        {written
          ? speech.graveside
            ? 'Written, with a graveside version alongside it.'
            : 'Written. Read it aloud when you have a quiet ten minutes.'
          : 'Set up, waiting for its first draft.'}
      </span>
    </Link>
  );
}
