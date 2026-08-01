'use client';

/**
 * The speech, and the four buttons beside it.
 *
 * The text is the interface: a full-width box in the reading serif, saved as
 * they type, with no Save button anywhere. The tools are deliberately modest —
 * each one makes a new version, and the previous version is one click away in
 * the History list underneath, so pressing a button can never be a mistake that
 * costs somebody their paragraph.
 *
 * When a model call fails, the words stay exactly where they are and one calm
 * sentence appears above them. That is the most important behaviour in this
 * file.
 */
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { EulogyRevision } from '@col/ai';
import { step } from '@/components/StepScreen';
import { SavedIndicator, type SaveState } from '@/components/SavedIndicator';
import { draftSpeechAction, reviseSpeechAction, saveSpeechBodyAction } from '../actions';
import styles from '../speeches.module.css';

export const DRAFT_SAVE_DELAY_MS = 800;

export type ToolButton = {
  revision: EulogyRevision;
  label: string;
  help: string;
};

export type DraftToolsProps = {
  memorialId: string;
  speechId: string;
  body: string;
  /** Changes when a new version is written, so the box picks the new text up. */
  versionKey: string;
  variant?: 'full' | 'graveside';
  tools: ToolButton[];
  /** No draft yet: the only button is the one that writes the first one. */
  needsFirstDraft: boolean;
  speakerLine: string;
};

export function DraftTools({
  memorialId,
  speechId,
  body,
  versionKey,
  variant = 'full',
  tools,
  needsFirstDraft,
  speakerLine,
}: DraftToolsProps) {
  const router = useRouter();
  const [text, setText] = useState(body);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // A new version means new words in the box. Keyed on the version rather than
  // on the text, so this never fights somebody's own typing.
  const shownFor = useRef(versionKey);
  useEffect(() => {
    if (shownFor.current === versionKey) return;
    shownFor.current = versionKey;
    setText(body);
    setSaveState('idle');
  }, [versionKey, body]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const flush = useCallback(
    (value: string) => {
      clearTimeout(timer.current);
      setSaveState('saving');
      void saveSpeechBodyAction({ memorialId, speechId, body: value, variant }).then(() =>
        setSaveState('saved'),
      );
    },
    [memorialId, speechId, variant],
  );

  function onChange(value: string) {
    setText(value);
    setSaveState('saving');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => flush(value), DRAFT_SAVE_DELAY_MS);
  }

  function run(revision: EulogyRevision | 'first-draft') {
    setError(undefined);
    clearTimeout(timer.current);
    startTransition(async () => {
      // Whatever is in the box is written first: a model call must never be the
      // reason a sentence somebody typed disappears.
      if (!needsFirstDraft) {
        await saveSpeechBodyAction({ memorialId, speechId, body: text, variant });
      }
      const result =
        revision === 'first-draft'
          ? await draftSpeechAction({ memorialId, speechId })
          : await reviseSpeechAction({ memorialId, speechId, revision, variant });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className={styles.studio}>
      <div>
        {error ? (
          <p className={step.error} role="alert">
            {error}
          </p>
        ) : null}

        {needsFirstDraft ? (
          <>
            <p className={styles.hint}>
              {speakerLine} This will be a first draft in your voice, built from the memories you
              ticked. You rewrite it from there — no one will know how it started.
            </p>
            <button
              type="button"
              className={step.primary}
              onClick={() => run('first-draft')}
              disabled={busy}
            >
              {busy ? 'Writing…' : 'Write a first draft'}
            </button>
          </>
        ) : (
          <>
            <label className="visually-hidden" htmlFor="speech">
              Your speech
            </label>
            <textarea
              id="speech"
              className={styles.draft}
              value={text}
              disabled={busy}
              onChange={(event) => onChange(event.target.value)}
              onBlur={() => flush(text)}
            />
            <div className={styles.savedRow}>
              <SavedIndicator state={saveState} />
            </div>
            <p className={styles.hint}>
              Every word here is yours to change. It saves itself as you type, and
              <span> </span>
              <strong>[pause]</strong> on a line of its own marks a moment to stop and breathe.
            </p>
          </>
        )}
      </div>

      {needsFirstDraft ? null : (
        <aside className={styles.tools}>
          <h2 className={styles.toolsTitle}>Change it</h2>
          {tools.map((tool) => (
            <button
              key={tool.revision}
              type="button"
              className={styles.tool}
              onClick={() => run(tool.revision)}
              disabled={busy}
            >
              <span>{tool.label}</span>
              <span className={styles.toolNote}>{tool.help}</span>
            </button>
          ))}
          {busy ? <p className={styles.hint}>One moment…</p> : null}
        </aside>
      )}
    </div>
  );
}
