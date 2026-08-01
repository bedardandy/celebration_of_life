'use client';

/**
 * Practising it out loud.
 *
 * Press play, read at your own pace, and the paragraph you should be somewhere
 * near is the one that is dark. It does not follow your voice — nothing here
 * listens to anybody — it simply keeps a reading pace, so the highlight is a
 * companion rather than a judge.
 *
 * The number at the end is the point of the whole thing: whatever the stopwatch
 * said, plan for a quarter more on the day, because everybody slows down. That
 * arithmetic lives in @col/core and is unit-tested; this owns only the clock.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatClock, isPauseMarker, paceParagraphs, readAloudSummary } from '@col/core/ui';
import { step } from '@/components/StepScreen';
import styles from '../speeches.module.css';

const TICK_MS = 250;

export function ReadAloudTimer({ body, targetMinutes }: { body: string; targetMinutes: number }) {
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [finished, setFinished] = useState(false);
  const startedAt = useRef<number | undefined>(undefined);
  const baseline = useRef(0);

  const paced = useMemo(() => paceParagraphs(body), [body]);
  const total = paced.reduce((sum, entry) => sum + entry.durationSec, 0);

  useEffect(() => {
    if (!running) return;
    startedAt.current = Date.now();
    const id = setInterval(() => {
      const since = (Date.now() - (startedAt.current ?? Date.now())) / 1000;
      setElapsed(baseline.current + since);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [running]);

  function play() {
    baseline.current = elapsed;
    setFinished(false);
    setRunning(true);
  }

  function pause() {
    baseline.current = elapsed;
    setRunning(false);
  }

  function stop() {
    setRunning(false);
    baseline.current = 0;
    setFinished(true);
  }

  function reset() {
    setRunning(false);
    baseline.current = 0;
    setElapsed(0);
    setFinished(false);
  }

  // Which paragraph a reader at an unhurried pace would be on now. It is a
  // guide, never a correction — a speaker who is slower than this is normal.
  const activeIndex = paced.findIndex(
    (entry) => elapsed >= entry.startSec && elapsed < entry.startSec + entry.durationSec,
  );
  const summary = readAloudSummary(elapsed, targetMinutes);

  // Keep the current paragraph in view. Only while running: a person scrolling
  // back to re-read something must not be dragged forward again.
  const active = useRef<HTMLParagraphElement | null>(null);
  useEffect(() => {
    if (!running) return;
    active.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [running, activeIndex]);

  return (
    <section className={styles.timer} aria-label="Read-aloud timer">
      <div className={styles.timerRow}>
        <span className={styles.timerClock}>{formatClock(elapsed)}</span>
        <span className={styles.timerTarget}>
          aiming for {targetMinutes} minutes · reads in about {formatClock(total)}
        </span>
      </div>

      <div className={styles.timerRow} style={{ marginTop: '16px' }}>
        {running ? (
          <button type="button" className={step.primary} onClick={pause}>
            Pause
          </button>
        ) : (
          <button type="button" className={step.primary} onClick={play}>
            {elapsed > 0 ? 'Carry on' : 'Read it aloud'}
          </button>
        )}
        <button type="button" className={step.quiet} onClick={stop} disabled={elapsed === 0}>
          I have finished
        </button>
        <button type="button" className={step.quiet} onClick={reset} disabled={elapsed === 0}>
          Start again
        </button>
      </div>

      {finished || elapsed > 0 ? (
        <>
          <p className={styles.timerSummary}>{summary.line}</p>
          {finished ? <p className={styles.timerVerdict}>{summary.verdict}</p> : null}
        </>
      ) : (
        <p className={styles.timerVerdict}>
          Read it at the pace you would actually say it. Nothing is recorded, and nothing is
          listening.
        </p>
      )}

      <div className={styles.timerScript}>
        {paced.map((entry) => (
          <p
            key={entry.index}
            ref={entry.index === activeIndex ? active : undefined}
            className={`${styles.timerParagraph} ${
              entry.index === activeIndex ? styles.timerParagraphOn : ''
            } ${isPauseMarker(entry.text) ? styles.timerPause : ''}`}
          >
            {isPauseMarker(entry.text) ? '· · ·' : entry.text}
          </p>
        ))}
      </div>
    </section>
  );
}
