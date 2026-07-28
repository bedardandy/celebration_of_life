'use client';

/**
 * Copy, with a way out.
 *
 * The clipboard API fails silently on older Safari, inside some in-app
 * browsers, and on any page not served over HTTPS — all of which describe a
 * real organiser's phone. So the text is always visible and always selectable,
 * and the button is an accelerant rather than the only route. The confirmation
 * says what happened in words, not with a colour change.
 */
import { useState } from 'react';
import { step } from '@/components/StepScreen';
import styles from './photos.module.css';

export function CopyBox({
  value,
  label,
  multiline,
}: {
  value: string;
  label: string;
  multiline?: boolean;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'select'>('idle');

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      // No clipboard access. Tell them what to do instead of failing quietly.
      setState('select');
    }
  }

  return (
    <div className={styles.copyBox}>
      <p className={styles.copyLabel}>{label}</p>
      {multiline ? (
        <textarea className={styles.copyText} readOnly value={value} rows={7} />
      ) : (
        <input className={styles.copyText} readOnly value={value} />
      )}
      <div className={styles.copyRow}>
        <button type="button" className={step.quiet} onClick={copy}>
          Copy
        </button>
        <span className={styles.copyState} aria-live="polite">
          {state === 'copied'
            ? 'Copied.'
            : state === 'select'
              ? 'Select the text above and copy it.'
              : ''}
        </span>
      </div>
    </div>
  );
}
