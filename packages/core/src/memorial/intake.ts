/**
 * The intake wizard: four questions, one per screen, every one skippable.
 *
 * Two things make this survivable for someone with grief brain. Every answer is
 * written to the database the moment it is given — there is no Save button and
 * no draft state — and the furthest question reached is recorded, so closing
 * the tab and coming back through the emailed link lands on the same screen
 * with the same answers already filled in.
 *
 * A skipped question is a real answer, not a gap. That is why `intakeStep`
 * exists: without it, "skipped" and "never seen" are indistinguishable.
 */
import { getById, memorials, updateById, type Db, type Memorial } from '@col/db';
import { DEFAULT_TRADITION_SLUG, findPack, getPack } from '@col/tradition-packs';
import { derivePacingPreset } from './pacing';

export const INTAKE_STEPS = ['relationship', 'tradition', 'service-date', 'gathering'] as const;
export type IntakeStep = (typeof INTAKE_STEPS)[number];

export function isIntakeStep(value: unknown): value is IntakeStep {
  return typeof value === 'string' && (INTAKE_STEPS as readonly string[]).includes(value);
}

export function intakeStepIndex(step: IntakeStep): number {
  return INTAKE_STEPS.indexOf(step);
}

export function nextIntakeStep(step: IntakeStep): IntakeStep | undefined {
  return INTAKE_STEPS[intakeStepIndex(step) + 1];
}

export function previousIntakeStep(step: IntakeStep): IntakeStep | undefined {
  const i = intakeStepIndex(step);
  return i > 0 ? INTAKE_STEPS[i - 1] : undefined;
}

/**
 * Where a returning organiser should land. Answered questions are behind them;
 * a finished wizard sends them to the dashboard (undefined).
 */
export function resumeIntakeStep(
  memorial: Pick<Memorial, 'intakeStep' | 'intakeCompletedAt'>,
): IntakeStep | undefined {
  if (memorial.intakeCompletedAt != null) return undefined;
  if (!isIntakeStep(memorial.intakeStep)) return INTAKE_STEPS[0];
  return nextIntakeStep(memorial.intakeStep) ?? undefined;
}

/**
 * Whether a question has been put to this organiser yet. A skipped question
 * counts as answered — that is the whole reason the marker exists.
 */
export function hasAnsweredIntakeStep(
  memorial: Pick<Memorial, 'intakeStep'>,
  step: IntakeStep,
): boolean {
  return (
    isIntakeStep(memorial.intakeStep) &&
    intakeStepIndex(memorial.intakeStep) >= intakeStepIndex(step)
  );
}

/* -------------------------------------------------------------------------- */
/* Options                                                                     */
/* -------------------------------------------------------------------------- */

export type IntakeOption = { value: string; label: string };

export const RELATIONSHIP_OPTIONS: readonly IntakeOption[] = [
  { value: 'spouse-partner', label: 'Their spouse or partner' },
  { value: 'child', label: 'Their child' },
  { value: 'parent', label: 'Their parent' },
  { value: 'sibling', label: 'Their brother or sister' },
  { value: 'friend', label: 'Their friend' },
  { value: 'other', label: 'Someone else close to them' },
];

export const GATHERING_OPTIONS: readonly IntakeOption[] = [
  { value: 'funeral', label: 'A funeral service' },
  { value: 'celebration-of-life', label: 'A celebration of life' },
  { value: 'memorial', label: 'A memorial gathering' },
  { value: 'undecided', label: 'Still deciding' },
];

/** The answer for "I do not know", which is a perfectly normal answer. */
export const UNSURE_TRADITION = 'unsure';

export type TraditionChoice = {
  value: string;
  label: string;
  /** One short line, so the grid is choosable without reading an essay. */
  note: string;
};

export function traditionChoices(packs: { slug: string; label: string }[]): TraditionChoice[] {
  const fromPacks = packs.map((pack) => ({
    value: pack.slug,
    label: pack.label,
    note: traditionNote(pack.slug),
  }));
  return [
    ...fromPacks,
    {
      value: UNSURE_TRADITION,
      label: 'Not sure, or none',
      note: 'We will keep the wording neutral. You can change this later.',
    },
  ];
}

function traditionNote(slug: string): string {
  const pack = findPack(slug);
  if (!pack) return '';
  // First sentence of the timeline note: enough to recognise, short enough to scan.
  const first = pack.serviceTimelineNote.split(/(?<=\.)\s/)[0] ?? '';
  return first;
}

/* -------------------------------------------------------------------------- */
/* Saving                                                                      */
/* -------------------------------------------------------------------------- */

function loadMemorial(db: Db, memorialId: string): Memorial {
  const memorial = getById(db, memorials, memorialId);
  if (!memorial) throw new Error(`No memorial ${memorialId}`);
  return memorial;
}

/** Records progress. Never moves the marker backwards when revisiting a screen. */
function markStep(memorial: Memorial, step: IntakeStep): { intakeStep: IntakeStep } {
  const current = isIntakeStep(memorial.intakeStep) ? memorial.intakeStep : undefined;
  const furthest = current && intakeStepIndex(current) > intakeStepIndex(step) ? current : step;
  return { intakeStep: furthest };
}

export function saveRelationship(
  db: Db,
  memorialId: string,
  relationship: string | null,
): Memorial {
  const memorial = loadMemorial(db, memorialId);
  const known = RELATIONSHIP_OPTIONS.some((o) => o.value === relationship);
  return (
    updateById(db, memorials, memorialId, {
      organizerRelationship: known ? relationship : null,
      ...markStep(memorial, 'relationship'),
    }) ?? memorial
  );
}

/**
 * Choosing a tradition also re-derives the pacing preset, so the dashboard is
 * correct the moment the choice is made rather than only at the end.
 * "Not sure" keeps the neutral secular pacing without labelling the family.
 */
export function saveTradition(
  db: Db,
  memorialId: string,
  slug: string | null,
  now: number = Date.now(),
): Memorial {
  const memorial = loadMemorial(db, memorialId);
  const chosen =
    slug && slug !== UNSURE_TRADITION && findPack(slug) ? slug : DEFAULT_TRADITION_SLUG;
  const pack = getPack(chosen);
  return (
    updateById(db, memorials, memorialId, {
      traditionSlug: chosen,
      pacingPreset: derivePacingPreset(pack, memorial.serviceDate, now),
      ...markStep(memorial, 'tradition'),
    }) ?? memorial
  );
}

export type ServiceDateInput = {
  /** `YYYY-MM-DD` from a native date input. */
  date?: string | null;
  /** `HH:MM` from a native time input. Defaults to the early afternoon. */
  time?: string | null;
  timezone?: string | null;
};

export const DEFAULT_SERVICE_TIME = '13:00';

/**
 * Combines the three fields into an instant. Returns null when the date is
 * missing or unreadable — a half-typed date must never throw at someone.
 */
export function parseServiceDate(input: ServiceDateInput): {
  serviceDate: number | null;
  timezone: string;
} {
  const timezone = normalizeTimezone(input.timezone);
  const date = input.date?.trim();
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { serviceDate: null, timezone };
  const time =
    input.time?.trim() && /^\d{2}:\d{2}$/.test(input.time.trim())
      ? input.time.trim()
      : DEFAULT_SERVICE_TIME;
  const localMs = Date.parse(`${date}T${time}:00Z`);
  if (Number.isNaN(localMs)) return { serviceDate: null, timezone };
  return { serviceDate: localMs - timezoneOffsetMs(localMs, timezone), timezone };
}

function normalizeTimezone(value: string | null | undefined): string {
  const candidate = value?.trim();
  if (!candidate) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: candidate }).format(0);
    return candidate;
  } catch {
    return 'UTC';
  }
}

/**
 * Offset of `timezone` at the given instant, in milliseconds. Uses Intl rather
 * than a table so daylight saving is handled by the platform.
 */
function timezoneOffsetMs(utcMs: number, timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(utcMs));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
    const asUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour') % 24,
      get('minute'),
      get('second'),
    );
    return asUtc - utcMs;
  } catch {
    return 0;
  }
}

export function saveServiceDate(
  db: Db,
  memorialId: string,
  input: ServiceDateInput | null,
  now: number = Date.now(),
): Memorial {
  const memorial = loadMemorial(db, memorialId);
  const { serviceDate, timezone } = input
    ? parseServiceDate(input)
    : { serviceDate: null, timezone: memorial.timezone };
  const pack = getPack(memorial.traditionSlug);
  return (
    updateById(db, memorials, memorialId, {
      serviceDate,
      timezone,
      pacingPreset: derivePacingPreset(pack, serviceDate, now),
      ...markStep(memorial, 'service-date'),
    }) ?? memorial
  );
}

/**
 * Marks a question answered without touching its value. Used when a screen has
 * already autosaved and the person is simply moving on — pressing Continue must
 * never undo what autosave just wrote.
 */
export function markIntakeStep(db: Db, memorialId: string, step: IntakeStep): Memorial {
  const memorial = loadMemorial(db, memorialId);
  return updateById(db, memorials, memorialId, markStep(memorial, step)) ?? memorial;
}

export function saveGathering(db: Db, memorialId: string, kind: string | null): Memorial {
  const memorial = loadMemorial(db, memorialId);
  const known = GATHERING_OPTIONS.some((o) => o.value === kind);
  return (
    updateById(db, memorials, memorialId, {
      gatheringKind: known ? kind : null,
      ...markStep(memorial, 'gathering'),
    }) ?? memorial
  );
}

/**
 * Finishing the wizard. Re-derives the pacing preset from whatever was actually
 * answered, and moves the memorial out of draft so the dashboard is the home
 * screen from now on.
 */
export function completeIntake(db: Db, memorialId: string, now: number = Date.now()): Memorial {
  const memorial = loadMemorial(db, memorialId);
  const pack = getPack(memorial.traditionSlug);
  return (
    updateById(db, memorials, memorialId, {
      pacingPreset: derivePacingPreset(pack, memorial.serviceDate, now),
      status: memorial.status === 'draft' ? 'active' : memorial.status,
      intakeStep: INTAKE_STEPS[INTAKE_STEPS.length - 1],
      intakeCompletedAt: now,
    }) ?? memorial
  );
}
