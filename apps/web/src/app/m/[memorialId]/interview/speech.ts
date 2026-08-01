/**
 * Talking instead of typing.
 *
 * Some of the people using this are eighty, and the difference between "type
 * out the story of your mother's life" and "say it out loud" is the difference
 * between a page they abandon and a page they finish. Some are also crying,
 * which makes typing worse and talking easier.
 *
 * The browser does the listening — Chrome, Edge and Safari have a speech API
 * built in — so no audio leaves the machine, there is no server round trip, and
 * there is no new dependency. Firefox does not have it, so the button is not
 * shown there; that is the whole fallback, and the textarea underneath is
 * unchanged either way.
 *
 * This file holds only the parts worth testing on their own: finding the
 * constructor, and joining what was said onto what was already written.
 */

export type SpeechAlternative = { transcript: string };
export type SpeechResult = { isFinal: boolean; 0: SpeechAlternative; length: number };
export type SpeechResultList = { length: number; [index: number]: SpeechResult };

export type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: SpeechResultList;
};

export type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onend: (() => void) | null;
};

export type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

type MaybeScope = {
  SpeechRecognition?: unknown;
  webkitSpeechRecognition?: unknown;
};

/**
 * The constructor this browser offers, or nothing.
 *
 * Prefixed first is deliberate: Safari and Chrome both ship
 * `webkitSpeechRecognition`, and some browsers expose an unprefixed
 * `SpeechRecognition` that does not actually work. Whichever we find, it has to
 * be a function — a truthy property that is not constructible is worse than an
 * absent one, because it would put a button on screen that throws.
 */
export function speechRecognitionCtor(scope: unknown): SpeechRecognitionCtor | undefined {
  if (!scope || typeof scope !== 'object') return undefined;
  const candidate =
    (scope as MaybeScope).webkitSpeechRecognition ?? (scope as MaybeScope).SpeechRecognition;
  return typeof candidate === 'function' ? (candidate as SpeechRecognitionCtor) : undefined;
}

/** Feature detection, phrased as the question the component actually asks. */
export function isSpeechSupported(scope: unknown): boolean {
  return speechRecognitionCtor(scope) !== undefined;
}

/**
 * Put what was just said onto the end of what is already in the box.
 *
 * Spacing matters more than it sounds: the API hands back fragments with no
 * leading space, and a person who has stopped and started three times should
 * not find "her gardenshe grew". A fragment that starts with punctuation is
 * joined tight, the way it would be typed.
 */
export function appendTranscript(existing: string, spoken: string): string {
  const chunk = spoken.trim();
  if (!chunk) return existing;
  if (!existing) return chunk;
  if (/[\s]$/.test(existing)) return existing + chunk;
  if (/^[,.;:!?]/.test(chunk)) return existing + chunk;
  return `${existing} ${chunk}`;
}

/** Every final phrase in an event, joined. Interim results are ignored. */
export function finalTranscript(event: SpeechRecognitionEventLike): string {
  const parts: string[] = [];
  for (let i = event.resultIndex; i < event.results.length; i += 1) {
    const result = event.results[i];
    if (result?.isFinal) parts.push(result[0]?.transcript ?? '');
  }
  return parts.join(' ').trim();
}

/** The words on the button and around it, in one place so copy stays reviewable. */
export const SPEAK_COPY = {
  start: 'Speak instead',
  stop: 'Stop listening',
  listening: 'Listening. Talk as long as you like — we will write it down.',
  hint: 'You can talk instead of typing. Nothing is recorded; the words appear in the box.',
  problem: 'The microphone did not start. You can still type, and nothing has been lost.',
};
