'use client';

/**
 * One question, one box, three ways out.
 *
 * The whole screen is built around the assumption that the person typing may
 * stop mid-sentence and not come back for two days. So the text is saved as
 * they type — debounced, quietly acknowledged, never with a Save button — and
 * "Skip this question" and "I'm done for now" sit in plain sight next to
 * Continue, so stopping never feels like giving up.
 *
 * When the model fails, the answer stays in the box. That is the single most
 * important behaviour in this file.
 */
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { step } from '@/components/StepScreen';
import { SavedIndicator, type SaveState } from '@/components/SavedIndicator';
import { answerAction, pauseInterviewAction, saveDraftAction } from './actions';
import { SpeakButton } from './SpeakButton';
import styles from './interview.module.css';

export const DRAFT_SAVE_DELAY_MS = 800;

export type AnswerFormProps = {
  memorialId: string;
  sessionId: string;
  question: string;
  draft: string;
  /** Changes when the question does, so the box empties for the next one. */
  questionKey: string;
};

export function AnswerForm({
  memorialId,
  sessionId,
  question,
  draft,
  questionKey,
}: AnswerFormProps) {
  const router = useRouter();
  const [text, setText] = useState(draft);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [error, setError] = useState<string | undefined>(undefined);
  const [pending, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // A new question means a new empty box, and no stale draft carried over.
  // Keyed on the question rather than the draft: re-running this when `draft`
  // changes would fight the person's own typing.
  const shownFor = useRef(questionKey);
  useEffect(() => {
    if (shownFor.current === questionKey) return;
    shownFor.current = questionKey;
    setText(draft);
    setSaveState('idle');
    setError(undefined);
  }, [questionKey, draft]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const flush = useCallback(
    (value: string) => {
      clearTimeout(timer.current);
      setSaveState('saving');
      void saveDraftAction({ memorialId, sessionId, text: value }).then(() =>
        setSaveState('saved'),
      );
    },
    [memorialId, sessionId],
  );

  const onChange = useCallback(
    (value: string) => {
      setText(value);
      setSaveState('saving');
      clearTimeout(timer.current);
      timer.current = setTimeout(() => flush(value), DRAFT_SAVE_DELAY_MS);
    },
    [flush],
  );

  /**
   * Spoken words land in the box exactly as typed ones do — same state, same
   * debounced save — so there is one answer, not a transcript and a draft.
   */
  const onTranscript = useCallback(
    (next: (existing: string) => string) => {
      setText((existing) => {
        const value = next(existing);
        setSaveState('saving');
        clearTimeout(timer.current);
        timer.current = setTimeout(() => flush(value), DRAFT_SAVE_DELAY_MS);
        return value;
      });
    },
    [flush],
  );

  function submit(skipped: boolean) {
    clearTimeout(timer.current);
    setError(undefined);
    startTransition(async () => {
      const result = await answerAction({
        memorialId,
        sessionId,
        text: skipped ? '' : text,
        ...(skipped ? { skipped: true } : {}),
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div>
      {error ? (
        <p className={step.error} role="alert">
          {error}
        </p>
      ) : null}

      {/* The question is already the page's heading; this names the box for a
          screen reader without saying it twice on screen. */}
      <label className="visually-hidden" htmlFor="answer">
        {question}
      </label>
      <textarea
        id="answer"
        className={styles.answer}
        value={text}
        placeholder="Take your time."
        aria-label={question}
        disabled={pending}
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => flush(text)}
      />
      <div className={styles.savedRow}>
        <SavedIndicator state={saveState} />
      </div>

      <SpeakButton onTranscript={onTranscript} disabled={pending} />

      <p className={styles.answerHint}>
        Everything here saves itself. You can close this and come back whenever you like.
      </p>

      <div className={step.actions}>
        <button
          type="button"
          className={step.primary}
          onClick={() => submit(false)}
          disabled={pending || text.trim().length === 0}
        >
          {pending ? 'One moment…' : 'Continue'}
        </button>
        <div className={step.quietRow}>
          <button
            type="button"
            className={step.quiet}
            onClick={() => submit(true)}
            disabled={pending}
          >
            Skip this question
          </button>
          <form action={pauseInterviewAction} className={styles.inlineForm}>
            <input type="hidden" name="memorialId" value={memorialId} />
            <input type="hidden" name="sessionId" value={sessionId} />
            <button type="submit" className={step.quiet} disabled={pending}>
              I&rsquo;m done for now
            </button>
          </form>
        </div>
      </div>
      {pending ? <p className={styles.thinking}>Writing that down…</p> : null}
    </div>
  );
}
