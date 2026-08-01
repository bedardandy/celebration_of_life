/**
 * The program, as a list of five small decisions.
 *
 * It is the one thing from the day that people keep — in a Bible, in a drawer,
 * inside a photo album — so it is worth doing properly, and it is also the
 * thing most likely to be left until the night before. Five screens, each one
 * finishable in a minute, and every one of them already has something in it.
 */
import Link from 'next/link';
import { PROGRAM_STEPS, currentProgram, programProgress, type ProgramStep } from '@col/core';
import { StepScreen, step } from '@/components/StepScreen';
import { db } from '@/server/db';
import { requireOrganizer } from '@/server/auth';
import styles from './program.module.css';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'The printed program' };

const STEP_COPY: Record<ProgramStep, { title: string; help: string }> = {
  cover: { title: 'The front cover', help: 'Their photograph, their name, their dates.' },
  order: { title: 'The order of service', help: 'What happens, and who is doing it.' },
  sketch: {
    title: 'Their life, in a paragraph',
    help: 'A hundred and fifty to two hundred words.',
  },
  reading: { title: 'A reading or a verse', help: 'One suggestion, or paste your own.' },
  thanks: { title: 'The thank you', help: 'The line on the back, already written for you.' },
};

export default async function ProgramPage({ params }: { params: Promise<{ memorialId: string }> }) {
  const { memorialId } = await params;
  const { memorial } = await requireOrganizer(memorialId);

  const { doc, version } = currentProgram(db(), memorial);
  const progress = programProgress(doc);
  const done = new Map(progress.steps.map((entry) => [entry.step, entry.done]));

  return (
    <StepScreen
      wide
      eyebrow={`Remembering ${memorial.decedentName}`}
      title="The printed program"
      helper={progress.line}
      primary={
        <Link className={step.primary} href={`/m/${memorialId}/program/cover`}>
          {version === 0 ? 'Start the program' : 'Carry on'}
        </Link>
      }
      secondary={
        <>
          <Link className={step.quiet} href={`/m/${memorialId}/program/print`}>
            See it as it will print
          </Link>
          <Link className={step.quiet} href={`/m/${memorialId}/speeches`}>
            Back to speeches
          </Link>
        </>
      }
      footer="Everything saves as you go. Nothing here has to be finished in one sitting."
    >
      <ul className={styles.steps}>
        {PROGRAM_STEPS.map((name) => (
          <li key={name}>
            <Link className={styles.stepRow} href={`/m/${memorialId}/program/${name}`}>
              <span className={styles.stepTitle}>{STEP_COPY[name].title}</span>
              <span className={styles.stepHelp}>{STEP_COPY[name].help}</span>
              <span className={styles.stepState}>
                {done.get(name) ? 'Done' : name === 'reading' ? 'Optional' : 'Not yet'}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </StepScreen>
  );
}
