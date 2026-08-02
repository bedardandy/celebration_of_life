'use client';

/**
 * "Spotted something, or have a thought?"
 *
 * Two fields and one optional button. The button is the whole point: somebody
 * watching on a phone can say *where* they were without dragging a scrub bar,
 * which is the interaction that fails first for a person who is eighty, tired,
 * or crying. Pressing it reads the video's current time once and shows it back
 * as "at 1:23 — remove", so it can be taken off again in one tap.
 *
 * The name is remembered in this browser only, so a second thought ten minutes
 * later does not ask again. It grants nothing: the link is the credential, and
 * the name is only there so the family knows who to thank.
 */
import { useEffect, useState } from 'react';
import { step } from '@/components/StepScreen';
import { leaveNoteAction } from './actions';
import styles from './watch.module.css';

/** The `id` of the <video> on this page. Read once, when the button is pressed. */
export const WATCH_VIDEO_ID = 'tribute-video';

function rememberedNameKey(token: string): string {
  return `col_w_name_${token.replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}`;
}

function formatTimecode(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}

export function NoteForm({
  token,
  invitation,
  privacyLine,
  sent,
}: {
  token: string;
  invitation: string;
  privacyLine: string;
  sent: boolean;
}) {
  const [name, setName] = useState('');
  const [timecodeMs, setTimecodeMs] = useState<number | undefined>(undefined);

  useEffect(() => {
    try {
      setName(window.localStorage.getItem(rememberedNameKey(token)) ?? '');
    } catch {
      /* a browser with storage turned off simply asks again */
    }
  }, [token]);

  function remember(value: string) {
    setName(value);
    try {
      window.localStorage.setItem(rememberedNameKey(token), value);
    } catch {
      /* nothing to do, and nothing worth saying about it */
    }
  }

  function markThisMoment() {
    const video = document.getElementById(WATCH_VIDEO_ID);
    const current = video instanceof HTMLVideoElement ? video.currentTime : 0;
    setTimecodeMs(Math.max(0, Math.round(current * 1000)));
  }

  return (
    <section className={styles.notes} id="note">
      <h2 className={styles.notesTitle}>{invitation}</h2>

      {sent ? (
        <p className={styles.notesSent} role="status">
          Thank you. That has gone to the family.
        </p>
      ) : null}

      <form action={leaveNoteAction} className={styles.noteForm}>
        <input type="hidden" name="token" value={token} />
        {timecodeMs === undefined ? null : (
          <input type="hidden" name="timecodeMs" value={String(timecodeMs)} />
        )}

        <div>
          <label htmlFor="note-name">Your first name</label>
          <input
            id="note-name"
            name="name"
            type="text"
            autoComplete="given-name"
            value={name}
            onChange={(event) => remember(event.target.value)}
            placeholder="So the family knows who to thank"
          />
        </div>

        <div>
          <label htmlFor="note-body">What would you like to say?</label>
          <textarea
            id="note-body"
            name="note"
            rows={4}
            maxLength={800}
            placeholder="A name that is not quite right, a photo you have, anything at all."
          />
        </div>

        <div className={styles.noteMoment}>
          {timecodeMs === undefined ? (
            <button type="button" className={step.quiet} onClick={markThisMoment}>
              At this moment in the video
            </button>
          ) : (
            <button
              type="button"
              className={step.quiet}
              onClick={() => setTimecodeMs(undefined)}
              aria-label={`At ${formatTimecode(timecodeMs)} in the video — remove`}
            >
              at {formatTimecode(timecodeMs)} — remove
            </button>
          )}
        </div>

        <div>
          <button type="submit" className={step.primary}>
            Send this
          </button>
        </div>

        <p className={styles.notesPrivacy}>{privacyLine}</p>
      </form>
    </section>
  );
}
