/**
 * The layout every screen in this product uses.
 *
 * It exists to make the grief rules structural rather than a thing each page
 * has to remember: one title, one optional helper line, one primary action, and
 * anything else demoted to a quiet underlined link. If a screen needs two
 * primary buttons, it is two screens.
 */
import type { ReactNode } from 'react';
import styles from './StepScreen.module.css';

export type StepScreenProps = {
  title: string;
  /** One short line. If it needs two, the question is too big for one screen. */
  helper?: ReactNode;
  /** Small label above the title, e.g. the name of the person being remembered. */
  eyebrow?: ReactNode;
  children?: ReactNode;
  /** The single primary action. */
  primary?: ReactNode;
  /** Quiet links: Skip, Back, "not yet". Never buttons that compete. */
  secondary?: ReactNode;
  /** Progress dots, when this screen is one of a series. */
  progress?: { current: number; total: number };
  /** Reassurance or a way out, set below a rule at the bottom. */
  footer?: ReactNode;
  /** Wider column, for the dashboard's card grid. */
  wide?: boolean;
};

export function StepScreen({
  title,
  helper,
  eyebrow,
  children,
  primary,
  secondary,
  progress,
  footer,
  wide,
}: StepScreenProps) {
  return (
    <main className={styles.screen}>
      <div className={`${styles.inner} ${wide ? styles.wide : ''}`}>
        {progress ? <ProgressDots {...progress} /> : null}
        {eyebrow ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
        <h1 className={styles.title}>{title}</h1>
        {helper ? <p className={styles.helper}>{helper}</p> : null}
        {children ? <div className={styles.content}>{children}</div> : null}
        {primary || secondary ? (
          <div className={styles.actions}>
            {primary}
            {secondary ? <div className={styles.quietRow}>{secondary}</div> : null}
          </div>
        ) : null}
        {footer ? <div className={styles.footer}>{footer}</div> : null}
      </div>
    </main>
  );
}

export function ProgressDots({ current, total }: { current: number; total: number }) {
  return (
    <ol className={styles.dots} aria-label={`Question ${current} of ${total}`}>
      {Array.from({ length: total }, (_, i) => {
        const state = i + 1 < current ? styles.dotDone : i + 1 === current ? styles.dotCurrent : '';
        return <li key={i} className={`${styles.dot} ${state}`} />;
      })}
    </ol>
  );
}

export const step = styles;
