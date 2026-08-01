/**
 * Setting a speech up, one decision per screen.
 *
 * Who is speaking, how long, how it should sound, and which memories it should
 * lean on. The last screen is the one that matters most: nothing is ticked in
 * advance, because the speaker choosing the material is the whole difference
 * between a draft in their voice and a draft in somebody else's.
 */
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import {
  SPEAKER_RELATIONSHIPS,
  SPEECH_SETUP_STEPS,
  TONE_LABELS,
  isSpeechSetupStep,
  latestVersion,
  lengthOptions,
  notesOf,
  previousSpeechSetupStep,
  selectableMemories,
  setupCopy,
  speechSetupStepIndex,
  toneOptionsFor,
  type SelectableMemory,
} from '@col/core';
import type { EulogyDraftRow, Memorial } from '@col/db';
import { StepScreen, step as stepStyles } from '@/components/StepScreen';
import { db } from '@/server/db';
import { requireOrganizer } from '@/server/auth';
import { saveSetupStepAction } from '../../../actions';
import styles from '../../../speeches.module.css';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Setting up a speech' };

export default async function SpeechSetupPage({
  params,
}: {
  params: Promise<{ memorialId: string; speechId: string; step: string }>;
}) {
  const { memorialId, speechId, step: rawStep } = await params;
  if (!isSpeechSetupStep(rawStep)) notFound();
  const { memorial } = await requireOrganizer(memorialId);

  const current = latestVersion(db(), speechId);
  if (!current || current.memorialId !== memorialId) redirect(`/m/${memorialId}/speeches`);

  const firstName = memorial.decedentKnownAs?.trim() || memorial.decedentName.split(/\s+/)[0] || '';
  const copy = setupCopy(rawStep, firstName);
  const back = previousSpeechSetupStep(rawStep);

  return (
    <StepScreen
      eyebrow={`Remembering ${memorial.decedentName}`}
      title={copy.title}
      helper={copy.helper}
      progress={{
        current: speechSetupStepIndex(rawStep) + 1,
        total: SPEECH_SETUP_STEPS.length,
      }}
      primary={
        rawStep === 'speaker' || rawStep === 'memories' ? (
          <button type="submit" form="setup" className={stepStyles.primary}>
            Continue
          </button>
        ) : undefined
      }
      secondary={
        <>
          <button type="submit" form="skip" className={stepStyles.quiet}>
            {copy.skipLabel}
          </button>
          {back ? (
            <Link
              className={stepStyles.quiet}
              href={`/m/${memorialId}/speeches/${speechId}/setup/${back}`}
            >
              Back
            </Link>
          ) : null}
        </>
      }
      footer="Every answer saves as you give it. You can change any of them later."
    >
      {/* A second, empty form so "skip" is one tap and never submits the fields. */}
      <form id="skip" action={saveSetupStepAction} hidden>
        <input type="hidden" name="memorialId" value={memorialId} />
        <input type="hidden" name="speechId" value={speechId} />
        <input type="hidden" name="step" value={rawStep} />
      </form>

      <StepBody
        memorialId={memorialId}
        speechId={speechId}
        stepValue={rawStep}
        current={current}
        memorial={memorial}
      />
    </StepScreen>
  );
}

function StepBody({
  memorialId,
  speechId,
  stepValue,
  current,
  memorial,
}: {
  memorialId: string;
  speechId: string;
  stepValue: (typeof SPEECH_SETUP_STEPS)[number];
  current: EulogyDraftRow;
  memorial: Memorial;
}) {
  const hidden = (
    <>
      <input type="hidden" name="memorialId" value={memorialId} />
      <input type="hidden" name="speechId" value={speechId} />
      <input type="hidden" name="step" value={stepValue} />
    </>
  );

  if (stepValue === 'speaker') {
    return (
      <form id="setup" action={saveSetupStepAction}>
        {hidden}
        <label className={styles.field}>
          <span className={styles.label}>Your name, as you would like it read out</span>
          <input
            className={styles.input}
            name="speakerName"
            defaultValue={current.speakerName}
            placeholder="Anne Hartley"
            autoComplete="name"
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>How you were related</span>
          <input
            className={styles.input}
            name="relationship"
            defaultValue={current.relationship ?? ''}
            placeholder="her daughter"
            list="relationships"
          />
          <datalist id="relationships">
            {SPEAKER_RELATIONSHIPS.map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
        </label>
        <p className={styles.hint}>
          Both go in the first line of the draft: “I am Anne, and Ruth was my mother.” You can
          change that line to anything you like.
        </p>
      </form>
    );
  }

  if (stepValue === 'length') {
    return (
      <form action={saveSetupStepAction}>
        {hidden}
        <div className={stepStyles.choices}>
          {lengthOptions().map((option) => (
            <button
              key={option.minutes}
              type="submit"
              name="targetMinutes"
              value={String(option.minutes)}
              className={`${stepStyles.choice} ${
                current.targetMinutes === option.minutes ? stepStyles.choiceSelected : ''
              }`}
              aria-pressed={current.targetMinutes === option.minutes}
            >
              <span>{option.label}</span>
              <span className={stepStyles.choiceNote}>{option.note}</span>
            </button>
          ))}
        </div>
        <p className={styles.hint}>
          Whatever you choose, practise it out loud once. Nearly everyone reads more slowly on the
          day than they do in the kitchen — the timer on the next screen allows for that.
        </p>
      </form>
    );
  }

  if (stepValue === 'tone') {
    const tones = toneOptionsFor(memorial.traditionSlug);
    return (
      <form action={saveSetupStepAction}>
        {hidden}
        <div className={stepStyles.choices}>
          {tones.map((tone) => (
            <button
              key={tone}
              type="submit"
              name="tone"
              value={tone}
              className={`${stepStyles.choice} ${
                current.tone === tone ? stepStyles.choiceSelected : ''
              }`}
              aria-pressed={current.tone === tone}
            >
              <span>{TONE_LABELS[tone].label}</span>
              <span className={stepStyles.choiceNote}>{TONE_LABELS[tone].note}</span>
            </button>
          ))}
        </div>
      </form>
    );
  }

  const memories = selectableMemories(db(), memorial);
  const chosen = new Set(notesOf(current).selectedMemoryIds);

  return (
    <form id="setup" action={saveSetupStepAction}>
      {hidden}
      {memories.length === 0 ? (
        <p className={styles.hint}>
          There are no kept memories yet. That is completely fine — we will write from the story so
          far, and you can come back and add memories to it later.
        </p>
      ) : (
        <ul className={styles.memories}>
          {memories.map((memory) => (
            <li key={memory.id}>
              <MemoryChoice memory={memory} checked={chosen.has(memory.id)} />
            </li>
          ))}
        </ul>
      )}
      <p className={styles.hint}>
        Nothing else is sent anywhere. The draft is built from what you tick here and from the story
        your family has already written down.
      </p>
    </form>
  );
}

function MemoryChoice({ memory, checked }: { memory: SelectableMemory; checked: boolean }) {
  return (
    <label className={styles.memory}>
      <input
        className={styles.memoryBox}
        type="checkbox"
        name="memoryId"
        value={memory.id}
        defaultChecked={checked}
      />
      <span>
        <span className={styles.memoryText}>{memory.text}</span>
        <span className={styles.memoryFrom}>
          {memory.attribution}
          {memory.chapterTitle ? ` · ${memory.chapterTitle}` : ''}
        </span>
      </span>
    </label>
  );
}
