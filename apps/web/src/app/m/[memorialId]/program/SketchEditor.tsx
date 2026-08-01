'use client';

/**
 * The life sketch: a box, an autosave, and one button that offers a draft.
 *
 * The offer is phrased as an offer. Plenty of people want to write this
 * themselves and should not have to refuse anything to do so; plenty of others
 * have been staring at the box for twenty minutes, and for them the button is
 * the whole product.
 */
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { step } from '@/components/StepScreen';
import { SavedIndicator, type SaveState } from '@/components/SavedIndicator';
import { draftSketchAction, saveSketchAction } from './actions';
import styles from './program.module.css';

export const SKETCH_SAVE_DELAY_MS = 800;

export function SketchEditor({
  memorialId,
  text: initial,
  version,
  fitNote,
}: {
  memorialId: string;
  text: string;
  /** Changes when a new version is written, so the box picks the new text up. */
  version: number;
  fitNote?: string;
}) {
  const router = useRouter();
  const [text, setText] = useState(initial);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const shownFor = useRef(version);
  useEffect(() => {
    if (shownFor.current === version) return;
    shownFor.current = version;
    setText(initial);
    setSaveState('idle');
  }, [version, initial]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const flush = useCallback(
    (value: string) => {
      clearTimeout(timer.current);
      setSaveState('saving');
      void saveSketchAction({ memorialId, text: value }).then(() => setSaveState('saved'));
    },
    [memorialId],
  );

  function onChange(value: string) {
    setText(value);
    setSaveState('saving');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => flush(value), SKETCH_SAVE_DELAY_MS);
  }

  function draft() {
    setError(undefined);
    clearTimeout(timer.current);
    startTransition(async () => {
      // Whatever is in the box is written first, and kept as its own version.
      if (text.trim()) await saveSketchAction({ memorialId, text });
      const result = await draftSketchAction({ memorialId });
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

      <label className="visually-hidden" htmlFor="sketch">
        Their life, in a paragraph or two
      </label>
      <textarea
        id="sketch"
        className={styles.sketch}
        value={text}
        disabled={busy}
        placeholder="Where they began, what they did, who they loved, and one thing that was unmistakably them."
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => flush(text)}
      />
      <div className={styles.savedRow}>
        <SavedIndicator state={saveState} />
      </div>

      <p className={styles.hint}>
        {fitNote ? `${fitNote} ` : ''}
        This is the part people read at the back of the room, and again at home a year later.
      </p>

      <button type="button" className={styles.tool} onClick={draft} disabled={busy}>
        <span>{busy ? 'Writing…' : 'Draft it from their story'}</span>
        <span className={styles.toolNote}>
          Built only from what your family has already written down. Yours to rewrite, and the
          version you have now is kept.
        </span>
      </button>
    </div>
  );
}
