/**
 * The four questions asked before a draft exists.
 *
 * One decision per screen, in the order a person actually decides them: who is
 * speaking, how long they have, how it should sound, and which memories it
 * should be built on. Nothing is preselected on the last one — the whole point
 * of the studio is that the speaker chooses the material.
 */
import { EULOGY_TARGET_MINUTES } from '@col/schemas';
import { wordsForMinutes } from '@col/ai';
import type { EulogyDraftRow } from '@col/db';

export const SPEECH_SETUP_STEPS = ['speaker', 'length', 'tone', 'memories'] as const;
export type SpeechSetupStep = (typeof SPEECH_SETUP_STEPS)[number];

export function isSpeechSetupStep(value: unknown): value is SpeechSetupStep {
  return typeof value === 'string' && (SPEECH_SETUP_STEPS as readonly string[]).includes(value);
}

export function speechSetupStepIndex(step: SpeechSetupStep): number {
  return SPEECH_SETUP_STEPS.indexOf(step);
}

export function nextSpeechSetupStep(step: SpeechSetupStep): SpeechSetupStep | undefined {
  return SPEECH_SETUP_STEPS[speechSetupStepIndex(step) + 1];
}

export function previousSpeechSetupStep(step: SpeechSetupStep): SpeechSetupStep | undefined {
  const index = speechSetupStepIndex(step);
  return index > 0 ? SPEECH_SETUP_STEPS[index - 1] : undefined;
}

/** Relationship chips. Typing is always allowed; these are just faster. */
export const SPEAKER_RELATIONSHIPS: readonly string[] = [
  'their daughter',
  'their son',
  'their wife',
  'their husband',
  'their sister',
  'their brother',
  'their granddaughter',
  'their grandson',
  'their friend',
  'their colleague',
];

export type LengthOption = {
  minutes: number;
  label: string;
  /** "about 650 spoken words" — the number that makes the choice concrete. */
  note: string;
};

/**
 * Five to ten minutes is the eulogy norm; three is offered for anyone who knows
 * they will not manage more, which is a completely reasonable thing to know.
 */
export function lengthOptions(): LengthOption[] {
  return EULOGY_TARGET_MINUTES.map((minutes) => ({
    minutes,
    label: `${minutes} minutes`,
    note:
      minutes === 3
        ? `About ${wordsForMinutes(minutes)} spoken words. Short is completely fine.`
        : minutes === 10
          ? `About ${wordsForMinutes(minutes)} spoken words. This is the long end of usual.`
          : `About ${wordsForMinutes(minutes)} spoken words.`,
  }));
}

/** "Anne's words", or "A speech" before anybody has said who is speaking. */
export function speechTitle(row: Pick<EulogyDraftRow, 'speakerName'>): string {
  const name = row.speakerName.trim();
  if (!name) return 'A speech';
  const first = name.split(/\s+/)[0] ?? name;
  return `${first}${first.endsWith('s') ? '’' : '’s'} words`;
}

/** Where a half-finished speech should resume. */
export function resumeSetupStep(
  row: Pick<EulogyDraftRow, 'speakerName' | 'status'>,
): SpeechSetupStep | undefined {
  if (row.status !== 'setup') return undefined;
  return row.speakerName.trim() ? 'length' : 'speaker';
}

export type SetupCopy = { title: string; helper: string; skipLabel: string };

export function setupCopy(step: SpeechSetupStep, subjectName: string): SetupCopy {
  switch (step) {
    case 'speaker':
      return {
        title: 'Who is speaking?',
        helper: 'Your name, and how you were related. Both go in the first line of the draft.',
        skipLabel: 'I will decide later',
      };
    case 'length':
      return {
        title: 'Roughly how long?',
        helper:
          'Five to ten minutes is usual. Whatever you choose, we will come in a little under it — ' +
          'people add on the day, they rarely cut.',
        skipLabel: 'Not sure — use five minutes',
      };
    case 'tone':
      return {
        title: 'How should it sound?',
        helper: 'You can change this later, and the draft is yours to rewrite either way.',
        skipLabel: 'Skip this',
      };
    case 'memories':
      return {
        title: `Which memories should it lean on?`,
        helper:
          `Tick the ones you want in your speech. Only these are used — nothing else about ` +
          `${subjectName} goes into the draft.`,
        skipLabel: 'None of these — write it from the story',
      };
  }
}
