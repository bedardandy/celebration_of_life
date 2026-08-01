'use client';

/**
 * "Speak instead."
 *
 * Progressive enhancement, in the strict sense: the answer box works exactly as
 * it did before, and this button is added on top of it in the browsers that can
 * do it. Where the browser cannot, there is no button, no explanation and no
 * "your browser is not supported" — just the textarea, which was always enough.
 *
 * The detection runs after mount rather than during render, because the server
 * has no `window` and a button that appears only on the client must not be part
 * of the HTML the server sent.
 */
import { useEffect, useRef, useState } from 'react';
import { step } from '@/components/StepScreen';
import {
  SPEAK_COPY,
  appendTranscript,
  finalTranscript,
  speechRecognitionCtor,
  type SpeechRecognitionLike,
} from './speech';
import styles from './interview.module.css';

export type SpeakButtonProps = {
  /** Called with the whole new value, so the caller's autosave runs unchanged. */
  onTranscript: (next: (existing: string) => string) => void;
  disabled?: boolean;
};

export function SpeakButton({ onTranscript, disabled }: SpeakButtonProps) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [problem, setProblem] = useState(false);
  const recognition = useRef<SpeechRecognitionLike | undefined>(undefined);

  useEffect(() => {
    setSupported(speechRecognitionCtor(globalThis) !== undefined);
    return () => {
      recognition.current?.abort();
      recognition.current = undefined;
    };
  }, []);

  if (!supported) return null;

  function stop() {
    recognition.current?.stop();
    recognition.current = undefined;
    setListening(false);
  }

  function start() {
    const Ctor = speechRecognitionCtor(globalThis);
    if (!Ctor) return;
    setProblem(false);

    try {
      const engine = new Ctor();
      engine.lang = document.documentElement.lang || 'en-GB';
      // Long pauses are normal here: somebody remembering their mother stops
      // mid-sentence. Continuous keeps the microphone open through them.
      engine.continuous = true;
      engine.interimResults = false;
      engine.onresult = (event) => {
        const spoken = finalTranscript(event);
        if (spoken) onTranscript((existing) => appendTranscript(existing, spoken));
      };
      engine.onerror = () => {
        setProblem(true);
        setListening(false);
        recognition.current = undefined;
      };
      engine.onend = () => {
        setListening(false);
        recognition.current = undefined;
      };
      engine.start();
      recognition.current = engine;
      setListening(true);
    } catch {
      setProblem(true);
      setListening(false);
    }
  }

  return (
    <div className={styles.speakRow}>
      <button
        type="button"
        className={step.quiet}
        onClick={listening ? stop : start}
        disabled={disabled}
      >
        {listening ? SPEAK_COPY.stop : SPEAK_COPY.start}
      </button>
      <span className={styles.speakHint} role="status" aria-live="polite">
        {problem ? SPEAK_COPY.problem : listening ? SPEAK_COPY.listening : SPEAK_COPY.hint}
      </span>
    </div>
  );
}
