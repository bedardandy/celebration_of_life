/**
 * The workflow state machine every memorial moves through.
 *
 * Phases are ordered but not a prison: families arrive mid-stream, skip steps,
 * and come back. The order exists so the dashboard can always answer the one
 * question that matters to someone with grief brain — "what would help right
 * now?" — without ever showing a blank page.
 */
export const WORKFLOW_PHASES = [
  'collect',
  'interview',
  'curate',
  'sequence',
  'score',
  'render',
  'deliver',
] as const;

export type WorkflowPhase = (typeof WORKFLOW_PHASES)[number];

/** Plain, brief language. No jargon, no verbs that imply extra work. */
export const PHASE_LABELS: Record<WorkflowPhase, string> = {
  collect: 'Gather photos',
  interview: 'Tell their story',
  curate: 'Choose the photos',
  sequence: 'Shape the story',
  score: 'Choose the music',
  render: 'Make the video',
  deliver: 'Get it to the service',
};

export const PHASE_HELP: Record<WorkflowPhase, string> = {
  collect: 'Send a link to family and friends. They can add photos without signing up.',
  interview: 'A few questions at a time. Skip anything. Come back whenever you like.',
  curate: 'Tap the photos you want. Nothing is deleted, and everything can be undone.',
  sequence: 'We suggest an order. You can change it, or leave it as it is.',
  score: 'Pick music we can include in the file, or time the video to a song played at the venue.',
  render: 'We build the video. This takes a few minutes; you can close the page.',
  deliver: 'Download the file, copy it to a USB stick, and print the card for the director.',
};

export function isWorkflowPhase(value: unknown): value is WorkflowPhase {
  return typeof value === 'string' && (WORKFLOW_PHASES as readonly string[]).includes(value);
}

export function phaseIndex(phase: WorkflowPhase): number {
  return WORKFLOW_PHASES.indexOf(phase);
}

export function nextPhase(phase: WorkflowPhase): WorkflowPhase | undefined {
  return WORKFLOW_PHASES[phaseIndex(phase) + 1];
}

export function previousPhase(phase: WorkflowPhase): WorkflowPhase | undefined {
  const i = phaseIndex(phase);
  return i > 0 ? WORKFLOW_PHASES[i - 1] : undefined;
}
