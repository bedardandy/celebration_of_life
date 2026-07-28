'use client';

/**
 * Tapping along to a song we will never hear.
 *
 * In side-loaded mode the recording never touches this machine — that is the
 * whole point — so if the slides are going to change with the music, somebody
 * has to tell us the tempo. Typing a BPM is meaningless to almost everyone;
 * tapping along to the song playing on their phone is something anyone can do.
 *
 * Eight taps is the ask, three is enough, and one distracted pause is forgiven:
 * the maths behind this (`tapTempoBpm`) takes the median interval and discards
 * outliers, so the number does not lurch because someone sneezed.
 */
import { useMemo, useRef, useState } from 'react';
import { describeTempo, tapTempoBpm } from '@col/media/beat-grid';
import styles from './music.module.css';

/** How many taps the button asks for before it stops counting down. */
export const TAPS_WANTED = 8;

export function TapTempo({ name = 'bpm' }: { name?: string }) {
  const [taps, setTaps] = useState<number[]>([]);
  const last = useRef(0);

  const reading = useMemo(() => tapTempoBpm(taps), [taps]);

  const tap = () => {
    const now = Date.now();
    // More than three seconds since the last tap: they stopped and started again.
    setTaps((current) => (now - last.current > 3000 ? [now] : [...current, now]));
    last.current = now;
  };

  const remaining = Math.max(0, TAPS_WANTED - taps.length);

  return (
    <div className={styles.tapRow}>
      <button type="button" className={styles.tapButton} onClick={tap}>
        {taps.length === 0
          ? 'Tap along to the song'
          : remaining > 0
            ? `Keep tapping — ${remaining} more`
            : 'Tap again to redo'}
      </button>

      <span className={styles.tapReading} aria-live="polite">
        {reading
          ? `${Math.round(reading.bpm)} BPM — ${describeTempo(reading.bpm)}${
              reading.confidence < 0.5 ? '. That was a bit uneven; try once more if you like.' : ''
            }`
          : 'Play the song and tap the button on the beat, about eight times.'}
      </span>

      {taps.length > 0 ? (
        <button
          type="button"
          className={styles.preview}
          onClick={() => {
            setTaps([]);
            last.current = 0;
          }}
        >
          Start again
        </button>
      ) : null}

      <input type="hidden" name={name} value={reading ? String(reading.bpm) : ''} />
    </div>
  );
}
