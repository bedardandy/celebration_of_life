'use client';

/**
 * "Saved just now."
 *
 * There are no Save buttons in this product, so this is the only thing telling
 * a person their answer is safe. It has to be quiet — no colour flash, no
 * movement — but it has to be there, because the anxiety it settles is real.
 *
 * The line keeps its height whether or not it is showing anything, so the page
 * never shifts under someone's finger.
 */
import { useEffect, useState } from 'react';
import styles from './SavedIndicator.module.css';

export type SaveState = 'idle' | 'saving' | 'saved';

export function SavedIndicator({ state }: { state: SaveState }) {
  const [label, setLabel] = useState<string>('');

  useEffect(() => {
    if (state === 'saving') {
      setLabel('Saving');
      return;
    }
    if (state !== 'saved') {
      setLabel('');
      return;
    }
    setLabel('Saved just now');
    const timer = setTimeout(() => setLabel('Saved'), 60_000);
    return () => clearTimeout(timer);
  }, [state]);

  return (
    <span className={styles.placeholder}>
      <span
        className={`${styles.indicator} ${state === 'saved' ? styles.saved : styles.saving}`}
        role="status"
        aria-live="polite"
      >
        {state === 'saved' ? <span className={styles.mark}>✓</span> : null}
        {label}
      </span>
    </span>
  );
}
