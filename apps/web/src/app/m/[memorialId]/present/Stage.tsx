'use client';

/**
 * Playing it in the room.
 *
 * A laptop on a table at the back, an HDMI cable, and somebody who has never
 * used this product pressing one button in front of two hundred people. That is
 * the whole design brief, and it rules out almost everything: no product chrome
 * on the projector, no thumbnail grid, no "are you sure", no autoplay, and
 * nothing that could put a spinner on the screen at the wrong moment.
 *
 * What is here instead:
 *
 *  - the rendered MP4, not the live preview. The file is the artifact of
 *    record — it is the thing ffprobe checked, and the thing on the USB stick;
 *  - a pre-roll of held black, so the room settles and the projector finishes
 *    switching input before the first photograph appears;
 *  - black at the end, held, so the last frame is not a paused video with a
 *    scrub bar across somebody's face;
 *  - controls that fade out while it plays and come back when the mouse moves;
 *  - space to play or pause, Escape to leave;
 *  - a five-second test with the sound up, before the room fills.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import styles from './present.module.css';

/** Held black before the first frame. Long enough for a projector to settle. */
export const PREROLL_SEC = 3;
/** The test plays this much, with the sound up, and then stops. */
export const TEST_SEC = 5;
/** Controls disappear after this much stillness while it is playing. */
const CHROME_IDLE_MS = 2500;

export type StageMode = 'idle' | 'preroll' | 'playing' | 'ended' | 'testing' | 'checking';

export type StageProps = {
  memorialId: string;
  /** Same-origin, session-authorised. Never a public URL. */
  videoSrc: string;
  posterSrc: string;
  decedentName: string;
  /** True when the music is baked into the file rather than played in the room. */
  soundInFile: boolean;
};

export function Stage({ memorialId, videoSrc, posterSrc, decedentName, soundInFile }: StageProps) {
  const router = useRouter();
  const video = useRef<HTMLVideoElement>(null);
  const prerollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [mode, setMode] = useState<StageMode>('idle');
  const [chromeVisible, setChromeVisible] = useState(true);

  const leave = useCallback(() => {
    if (typeof document !== 'undefined' && document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    }
    router.push(`/m/${memorialId}/deliver`);
  }, [memorialId, router]);

  /** Held black, then the first frame. */
  const start = useCallback(() => {
    const element = video.current;
    if (!element) return;
    element.currentTime = 0;
    element.muted = false;
    setMode('preroll');
    setChromeVisible(false);
    clearTimeout(prerollTimer.current);
    prerollTimer.current = setTimeout(() => {
      setMode('playing');
      void element.play().catch(() => {
        // A browser that refuses to play unmuted without a fresh gesture: fall
        // back to the button rather than showing the room a stuck black screen.
        setMode('idle');
        setChromeVisible(true);
      });
    }, PREROLL_SEC * 1000);
  }, []);

  const stop = useCallback(() => {
    const element = video.current;
    clearTimeout(prerollTimer.current);
    element?.pause();
    if (element) element.currentTime = 0;
    setMode('idle');
    setChromeVisible(true);
  }, []);

  /** Five seconds with the sound up, then the question that matters. */
  const test = useCallback(() => {
    const element = video.current;
    if (!element) return;
    element.currentTime = 0;
    element.muted = false;
    setMode('testing');
    setChromeVisible(true);
    void element.play().catch(() => setMode('idle'));
  }, []);

  const togglePlay = useCallback(() => {
    const element = video.current;
    if (!element) return;
    if (mode === 'idle' || mode === 'ended' || mode === 'checking') {
      start();
      return;
    }
    if (mode === 'preroll') {
      stop();
      return;
    }
    if (element.paused) void element.play().catch(() => {});
    else element.pause();
  }, [mode, start, stop]);

  /* keyboard ---------------------------------------------------------------- */

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        leave();
        return;
      }
      if (event.code === 'Space' || event.key === ' ') {
        // Not while somebody is tabbed onto a button: space is that button's own.
        const active = document.activeElement;
        if (active instanceof HTMLButtonElement || active instanceof HTMLAnchorElement) return;
        event.preventDefault();
        togglePlay();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [leave, togglePlay]);

  /* the chrome fading ------------------------------------------------------- */

  useEffect(() => {
    function wake() {
      setChromeVisible(true);
      clearTimeout(idleTimer.current);
      if (mode === 'playing' || mode === 'preroll') {
        idleTimer.current = setTimeout(() => setChromeVisible(false), CHROME_IDLE_MS);
      }
    }
    window.addEventListener('mousemove', wake);
    window.addEventListener('touchstart', wake);
    return () => {
      window.removeEventListener('mousemove', wake);
      window.removeEventListener('touchstart', wake);
      clearTimeout(idleTimer.current);
    };
  }, [mode]);

  useEffect(() => () => clearTimeout(prerollTimer.current), []);

  /* the test's own stopwatch ------------------------------------------------ */

  function onTimeUpdate() {
    const element = video.current;
    if (!element) return;
    if (mode === 'testing' && element.currentTime >= TEST_SEC) {
      element.pause();
      element.currentTime = 0;
      setMode('checking');
      setChromeVisible(true);
    }
  }

  const showCurtain = mode === 'idle' || mode === 'preroll' || mode === 'ended';

  return (
    <div className={styles.stage}>
      <video
        ref={video}
        className={styles.video}
        src={videoSrc}
        poster={posterSrc}
        preload="auto"
        playsInline
        aria-label={`Tribute video for ${decedentName}`}
        onEnded={() => {
          setMode('ended');
          setChromeVisible(true);
        }}
        onTimeUpdate={onTimeUpdate}
      />

      {showCurtain ? (
        <div className={styles.curtain}>
          {mode === 'idle' ? (
            <>
              <p className={styles.name}>{decedentName}</p>
              <button type="button" className={styles.play} onClick={start} autoFocus>
                Play
              </button>
              <p className={styles.hint}>
                The screen stays black for {PREROLL_SEC} seconds before the first photograph, so the
                room has a moment. Press space to play or pause. Press Escape to leave this screen.
              </p>
            </>
          ) : null}

          {mode === 'preroll' ? (
            <p className={styles.hint} role="status">
              Starting in a moment…
            </p>
          ) : null}

          {mode === 'ended' ? (
            <>
              <p className={styles.name}>{decedentName}</p>
              <p className={styles.hint}>That is the end. Nothing will play next.</p>
            </>
          ) : null}
        </div>
      ) : null}

      {mode === 'checking' ? (
        <div className={styles.curtain}>
          <div className={styles.check}>
            <h2 className={styles.checkTitle}>Did that work?</h2>
            <ul className={styles.checkList}>
              <li>Did a photograph appear on the big screen?</li>
              <li>
                {soundInFile
                  ? 'Did you hear the music through the room’s speakers?'
                  : 'Was the video silent, as it should be — and is whoever plays the song ready?'}
              </li>
              <li>Is the picture filling the screen, without a bar across it?</li>
            </ul>
            <div className={styles.checkRow}>
              <button type="button" className={styles.chromeButton} onClick={() => setMode('idle')}>
                Yes — we are ready
              </button>
              <button type="button" className={styles.chromeButton} onClick={test}>
                No — test it again
              </button>
            </div>
            <p className={styles.answer}>
              If there was no sound, the volume is usually the venue’s mixer rather than this
              laptop. If the picture had bars, set the projector to 16:9.
            </p>
          </div>
        </div>
      ) : null}

      <div className={`${styles.chrome} ${chromeVisible ? '' : styles.chromeHidden}`}>
        {mode === 'playing' || mode === 'testing' || mode === 'preroll' ? (
          <button type="button" className={styles.chromeButton} onClick={stop}>
            Stop
          </button>
        ) : (
          <button type="button" className={styles.chromeButton} onClick={start}>
            Play
          </button>
        )}
        <button type="button" className={styles.chromeButton} onClick={test}>
          Test {TEST_SEC} seconds with sound
        </button>
        <button type="button" className={styles.chromeButton} onClick={leave}>
          Leave this screen
        </button>
        <span className={styles.chromeNote}>
          Space plays and pauses. Escape leaves. These controls fade while it plays.
        </span>
      </div>
    </div>
  );
}
