'use client';

/**
 * Fifteen seconds of a track, on request.
 *
 * Nothing auto-plays anywhere in this product, and least of all here: a family
 * opening this screen in a quiet house at midnight must not have music start at
 * them. So it is a button, one track at a time, and it stops itself after
 * fifteen seconds with a short fade so the ending is not a click.
 *
 * The audio URL is an authorised route, not a public file — the same rule the
 * photographs follow.
 */
import { useEffect, useRef, useState } from 'react';
import styles from './music.module.css';

/** Long enough to know whether it is right, short enough not to be a sitting. */
export const PREVIEW_SEC = 15;
const FADE_SEC = 1.2;

export type TrackPreviewProps = {
  src: string;
  title: string;
};

export function TrackPreview({ src, title }: TrackPreviewProps) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [problem, setProblem] = useState(false);

  useEffect(() => {
    const element = audio.current;
    return () => {
      element?.pause();
    };
  }, []);

  const stop = () => {
    const element = audio.current;
    if (!element) return;
    element.pause();
    element.currentTime = 0;
    element.volume = 1;
    setPlaying(false);
  };

  const start = () => {
    const element = audio.current;
    if (!element) return;
    element.currentTime = 0;
    element.volume = 1;
    void element
      .play()
      .then(() => setPlaying(true))
      .catch(() => setProblem(true));
  };

  return (
    <>
      <button
        type="button"
        className={styles.preview}
        onClick={() => (playing ? stop() : start())}
        aria-label={playing ? `Stop ${title}` : `Listen to fifteen seconds of ${title}`}
      >
        {playing ? 'Stop' : `Listen · ${PREVIEW_SEC}s`}
      </button>
      <audio
        ref={audio}
        src={src}
        preload="none"
        onEnded={stop}
        onError={() => setProblem(true)}
        onTimeUpdate={(event) => {
          const element = event.currentTarget;
          const left = PREVIEW_SEC - element.currentTime;
          if (left <= 0) {
            stop();
            return;
          }
          // A short fade at the end of the preview: a sample that stops dead
          // sounds broken, and this screen is about how music feels.
          element.volume = left < FADE_SEC ? Math.max(0, left / FADE_SEC) : 1;
        }}
      />
      {problem ? <span className={styles.trackMeta}>That preview would not play.</span> : null}
    </>
  );
}
