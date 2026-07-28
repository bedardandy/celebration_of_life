/**
 * The interview screen.
 *
 * Three states, decided here so the components stay simple: never started (an
 * intro that promises nothing is lost), in progress (one question), and paused
 * (the same question, waiting). Coming back to this URL always continues where
 * they stopped — there is no "resume" to find, because there is no other way in.
 */
import Link from 'next/link';
import { hasStarted, readInterview, shortName, subjectOf } from '@col/core';
import { StepScreen, step } from '@/components/StepScreen';
import { db } from '@/server/db';
import { requireOrganizer } from '@/server/auth';
import { AnswerForm } from './AnswerForm';
import { StorySoFar } from './StorySoFar';
import { beginInterviewAction } from './actions';
import styles from './interview.module.css';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Their story' };

export default async function InterviewPage({
  params,
}: {
  params: Promise<{ memorialId: string }>;
}) {
  const { memorialId } = await params;
  const { memorial } = await requireOrganizer(memorialId);
  const name = shortName(subjectOf(memorial));

  const state = readInterview(db(), memorial);
  if (!state) {
    return (
      <IntroScreen memorialId={memorialId} name={name} returning={hasStarted(db(), memorialId)} />
    );
  }

  return (
    <StepScreen
      wide
      eyebrow={`Remembering ${memorial.decedentName}`}
      title={state.question.text}
      helper={
        state.answered === 0
          ? 'Answer as much or as little as you like.'
          : `${state.answered} ${state.answered === 1 ? 'answer' : 'answers'} so far. There is no finish line.`
      }
      footer={
        <div className={styles.inlineForm}>
          <Link className={step.quiet} href={`/m/${memorialId}/story`}>
            Back to the story page
          </Link>
        </div>
      }
    >
      <div className={styles.layout}>
        <AnswerForm
          memorialId={memorialId}
          sessionId={state.session.id}
          question={state.question.text}
          draft={state.draft}
          questionKey={`${state.session.id}:${state.answered}`}
        />
        <StorySoFar
          memorialId={memorialId}
          doc={state.doc}
          subjectName={name}
          returnTo={`/m/${memorialId}/interview`}
        />
      </div>
    </StepScreen>
  );
}

/**
 * The first screen. It has one button and no form, because the hardest part of
 * this whole product is deciding to start.
 */
function IntroScreen({
  memorialId,
  name,
  returning,
}: {
  memorialId: string;
  name: string;
  returning: boolean;
}) {
  return (
    <StepScreen
      eyebrow="Their story"
      title={returning ? `Picking up where you left off` : `Tell me about ${name}`}
      helper={
        returning
          ? 'Your answers are all still here. Nothing was lost.'
          : `I'll ask a few gentle questions about ${name}. Answer as much or as little as you like — you can stop any time and nothing is lost.`
      }
      primary={
        <form action={beginInterviewAction}>
          <input type="hidden" name="memorialId" value={memorialId} />
          <button type="submit" className={step.primary}>
            {returning ? 'Carry on' : 'Begin'}
          </button>
        </form>
      }
      secondary={
        <Link className={step.quiet} href={`/m/${memorialId}`}>
          Not now
        </Link>
      }
      footer="One question at a time. Skip anything you would rather not answer."
    />
  );
}
