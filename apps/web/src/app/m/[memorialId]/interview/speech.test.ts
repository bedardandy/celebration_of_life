/**
 * Talking instead of typing, tested without a browser.
 *
 * The only thing worth asserting here is the thing that decides whether a
 * button appears at all — because on a browser without the API the button must
 * not exist, and there is no "your browser is not supported" message to soften
 * it. Node has no `SpeechRecognition`, which makes this environment the
 * unsupported case, exactly as Firefox is.
 */
import { describe, expect, it } from 'vitest';
import {
  appendTranscript,
  finalTranscript,
  isSpeechSupported,
  speechRecognitionCtor,
} from './speech';

describe('finding the browser’s speech engine', () => {
  it('finds nothing here, so the button is hidden rather than broken', () => {
    expect(speechRecognitionCtor(globalThis)).toBeUndefined();
    expect(isSpeechSupported(globalThis)).toBe(false);
  });

  it('is not fooled by a property that is not constructible', () => {
    expect(isSpeechSupported({ SpeechRecognition: true })).toBe(false);
    expect(isSpeechSupported({ webkitSpeechRecognition: 'yes' })).toBe(false);
    expect(isSpeechSupported(undefined)).toBe(false);
    expect(isSpeechSupported('window')).toBe(false);
  });

  it('prefers the prefixed constructor, which is the one that works', () => {
    const webkit = function () {} as unknown;
    const plain = function () {} as unknown;
    expect(
      speechRecognitionCtor({ webkitSpeechRecognition: webkit, SpeechRecognition: plain }),
    ).toBe(webkit);
    expect(speechRecognitionCtor({ SpeechRecognition: plain })).toBe(plain);
  });
});

describe('joining spoken words onto written ones', () => {
  it('does not run words together', () => {
    expect(appendTranscript('her garden', 'she grew roses')).toBe('her garden she grew roses');
  });

  it('leaves an empty box holding only what was said', () => {
    expect(appendTranscript('', '  she grew roses ')).toBe('she grew roses');
  });

  it('keeps punctuation tight, the way it would be typed', () => {
    expect(appendTranscript('her garden', ', mostly roses')).toBe('her garden, mostly roses');
  });

  it('respects a space or a line break the person put there', () => {
    expect(appendTranscript('her garden\n', 'she grew roses')).toBe('her garden\nshe grew roses');
  });

  it('changes nothing when nothing was heard', () => {
    expect(appendTranscript('her garden', '   ')).toBe('her garden');
  });
});

describe('reading a result off an event', () => {
  it('takes the final phrases and ignores the guesses in between', () => {
    const spoken = finalTranscript({
      resultIndex: 0,
      results: {
        length: 3,
        0: { isFinal: true, length: 1, 0: { transcript: 'She kept bees' } },
        1: { isFinal: false, length: 1, 0: { transcript: 'and she' } },
        2: { isFinal: true, length: 1, 0: { transcript: 'for forty years' } },
      },
    });
    expect(spoken).toBe('She kept bees for forty years');
  });

  it('starts from the index the browser gave, not from the beginning', () => {
    const spoken = finalTranscript({
      resultIndex: 1,
      results: {
        length: 2,
        0: { isFinal: true, length: 1, 0: { transcript: 'already written down' } },
        1: { isFinal: true, length: 1, 0: { transcript: 'the new part' } },
      },
    });
    expect(spoken).toBe('the new part');
  });
});
