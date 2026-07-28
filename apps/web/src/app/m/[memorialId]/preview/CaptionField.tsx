'use client';

/**
 * A caption that saves itself.
 *
 * No Save button, in keeping with everywhere else: the line is written the
 * moment the person stops typing or looks away, and a quiet acknowledgement
 * appears. Somebody captioning forty photographs at midnight should be able to
 * close the tab between any two of them.
 */
import { useEffect, useRef, useState, useTransition } from 'react';
import { SavedIndicator, type SaveState } from '@/components/SavedIndicator';
import { setCaptionAction } from './actions';
import styles from './preview.module.css';

export const CAPTION_SAVE_DELAY_MS = 900;

export type CaptionFieldProps = {
  memorialId: string;
  slideId: string;
  cut: string;
  caption: string;
};

export function CaptionField({ memorialId, slideId, cut, caption }: CaptionFieldProps) {
  const [text, setText] = useState(caption);
  const [state, setState] = useState<SaveState>('idle');
  const [, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saved = useRef(caption);

  useEffect(() => () => clearTimeout(timer.current), []);

  const save = (value: string) => {
    clearTimeout(timer.current);
    if (value === saved.current) return;
    saved.current = value;
    setState('saving');
    const data = new FormData();
    data.set('memorialId', memorialId);
    data.set('slideId', slideId);
    data.set('cut', cut);
    data.set('caption', value);
    startTransition(async () => {
      await setCaptionAction(data);
      setState('saved');
    });
  };

  return (
    <div className={styles.captionRow}>
      <label className={styles.captionLabel} htmlFor={`caption-${slideId}`}>
        Caption
      </label>
      <input
        id={`caption-${slideId}`}
        className={styles.captionInput}
        type="text"
        value={text}
        maxLength={300}
        placeholder="A place, a year, who is in it — or nothing at all"
        onChange={(event) => {
          setText(event.target.value);
          setState('idle');
          clearTimeout(timer.current);
          timer.current = setTimeout(() => save(event.target.value), CAPTION_SAVE_DELAY_MS);
        }}
        onBlur={(event) => save(event.target.value)}
      />
      <SavedIndicator state={state} />
    </div>
  );
}
