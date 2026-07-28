import { notFound } from 'next/navigation';
import Link from 'next/link';
import {
  GATHERING_OPTIONS,
  INTAKE_STEPS,
  RELATIONSHIP_OPTIONS,
  hasAnsweredIntakeStep,
  intakeStepIndex,
  isIntakeStep,
  previousIntakeStep,
  traditionChoices,
  type IntakeStep,
} from '@col/core';
import { listPacks } from '@col/tradition-packs';
import type { Memorial } from '@col/db';
import { StepScreen, step } from '@/components/StepScreen';
import { requireOrganizer } from '@/server/auth';
import { answerStepAction } from '../actions';
import { KEEP } from '../keep';
import { ServiceDateFields } from './ServiceDateFields';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'A few questions' };

export default async function IntakeStepPage({
  params,
}: {
  params: Promise<{ memorialId: string; step: string }>;
}) {
  const { memorialId, step: rawStep } = await params;
  if (!isIntakeStep(rawStep)) notFound();
  const { memorial } = await requireOrganizer(memorialId);

  const copy = stepCopy(rawStep, memorial.decedentName);
  const back = previousIntakeStep(rawStep);

  return (
    <StepScreen
      eyebrow={`Remembering ${memorial.decedentName}`}
      title={copy.title}
      helper={copy.helper}
      progress={{ current: intakeStepIndex(rawStep) + 1, total: INTAKE_STEPS.length }}
      primary={
        rawStep === 'service-date' ? (
          <StepFormButton
            memorialId={memorialId}
            stepValue={rawStep}
            value={KEEP}
            className={step.primary}
            label="Continue"
          />
        ) : undefined
      }
      secondary={
        <>
          <StepFormButton
            memorialId={memorialId}
            stepValue={rawStep}
            value=""
            className={step.quiet}
            label={copy.skipLabel}
          />
          {back ? (
            <Link className={step.quiet} href={`/m/${memorialId}/intake/${back}`}>
              Back
            </Link>
          ) : null}
        </>
      }
      footer="Every answer saves as you give it. You can change any of them later."
    >
      <StepBody memorialId={memorialId} stepValue={rawStep} memorial={memorial} />
    </StepScreen>
  );
}

function StepBody({
  memorialId,
  stepValue,
  memorial,
}: {
  memorialId: string;
  stepValue: IntakeStep;
  memorial: Memorial;
}) {
  const answered = hasAnsweredIntakeStep(memorial, stepValue);

  if (stepValue === 'relationship') {
    return (
      <ChoiceList
        memorialId={memorialId}
        stepValue={stepValue}
        selected={memorial.organizerRelationship}
        options={RELATIONSHIP_OPTIONS.map((option) => ({ ...option }))}
      />
    );
  }

  if (stepValue === 'tradition') {
    return (
      <ChoiceList
        memorialId={memorialId}
        stepValue={stepValue}
        selected={answered ? memorial.traditionSlug : null}
        grid
        options={traditionChoices(listPacks())}
      />
    );
  }

  if (stepValue === 'gathering') {
    return (
      <ChoiceList
        memorialId={memorialId}
        stepValue={stepValue}
        selected={memorial.gatheringKind}
        options={GATHERING_OPTIONS.map((option) => ({ ...option }))}
      />
    );
  }

  return (
    <ServiceDateFields
      memorialId={memorialId}
      serviceDate={memorial.serviceDate}
      timezone={memorial.timezone}
    />
  );
}

/**
 * Chips as submit buttons: one tap both records the answer and moves on.
 * "Select, then press Continue" is two decisions where there should be one.
 */
function ChoiceList({
  memorialId,
  stepValue,
  options,
  selected,
  grid,
}: {
  memorialId: string;
  stepValue: IntakeStep;
  options: { value: string; label: string; note?: string }[];
  selected?: string | null;
  grid?: boolean;
}) {
  return (
    <form action={answerStepAction}>
      <input type="hidden" name="memorialId" value={memorialId} />
      <input type="hidden" name="step" value={stepValue} />
      <div className={`${step.choices} ${grid ? step.choicesGrid : ''}`}>
        {options.map((option) => (
          <button
            key={option.value}
            type="submit"
            name="value"
            value={option.value}
            className={`${step.choice} ${selected === option.value ? step.choiceSelected : ''}`}
            aria-pressed={selected === option.value}
          >
            <span>{option.label}</span>
            {option.note ? <span className={step.choiceNote}>{option.note}</span> : null}
          </button>
        ))}
      </div>
    </form>
  );
}

function StepFormButton({
  memorialId,
  stepValue,
  value,
  className,
  label,
}: {
  memorialId: string;
  stepValue: IntakeStep;
  value: string;
  className: string | undefined;
  label: string;
}) {
  return (
    <form action={answerStepAction}>
      <input type="hidden" name="memorialId" value={memorialId} />
      <input type="hidden" name="step" value={stepValue} />
      <input type="hidden" name="value" value={value} />
      <button type="submit" className={className}>
        {label}
      </button>
    </form>
  );
}

function stepCopy(
  stepValue: IntakeStep,
  decedentName: string,
): { title: string; helper: string; skipLabel: string } {
  const name = decedentName.split(' ')[0] || decedentName;
  switch (stepValue) {
    case 'relationship':
      return {
        title: `How were you related to ${name}?`,
        helper: 'It helps us ask the right questions later on.',
        skipLabel: 'Rather not say',
      };
    case 'tradition':
      return {
        title: 'Is there a faith or tradition to follow?',
        helper: 'It changes the timings, and where a photo tribute belongs.',
        skipLabel: 'Skip this question',
      };
    case 'service-date':
      return {
        title: 'Is the date of the service set?',
        helper: 'If it is not settled yet, skip this. You can add it whenever you know.',
        skipLabel: 'Not yet',
      };
    case 'gathering':
      return {
        title: 'What kind of gathering will it be?',
        helper: 'Only so we use the same words you do.',
        skipLabel: 'Skip this question',
      };
  }
}
