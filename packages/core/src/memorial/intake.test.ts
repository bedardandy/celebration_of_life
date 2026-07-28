import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, getById, memorials, type Db } from '@col/db';
import { listPacks } from '@col/tradition-packs';
import { createMemorial } from './create';
import {
  GATHERING_OPTIONS,
  INTAKE_STEPS,
  RELATIONSHIP_OPTIONS,
  UNSURE_TRADITION,
  completeIntake,
  hasAnsweredIntakeStep,
  isIntakeStep,
  markIntakeStep,
  nextIntakeStep,
  parseServiceDate,
  previousIntakeStep,
  resumeIntakeStep,
  saveGathering,
  saveRelationship,
  saveServiceDate,
  saveTradition,
  traditionChoices,
} from './intake';
import { MS_PER_DAY } from './pacing';

const NOW = Date.UTC(2026, 6, 28, 9, 0, 0);

let db: Db;
let memorialId: string;

function reload() {
  const row = getById(db, memorials, memorialId);
  if (!row) throw new Error('memorial vanished');
  return row;
}

beforeEach(() => {
  db = createTestDb();
  memorialId = createMemorial(db, {
    decedentName: 'Ruth Kelleher',
    organizerName: 'Anne',
    organizerEmail: 'anne@example.test',
    now: NOW,
  }).memorial.id;
});

describe('step order', () => {
  it('is the four intake questions', () => {
    expect([...INTAKE_STEPS]).toEqual(['relationship', 'tradition', 'service-date', 'gathering']);
    expect(nextIntakeStep('gathering')).toBeUndefined();
    expect(previousIntakeStep('relationship')).toBeUndefined();
    expect(previousIntakeStep('tradition')).toBe('relationship');
    expect(isIntakeStep('nope')).toBe(false);
  });
});

describe('each answer is written straight away', () => {
  it('stores the relationship', () => {
    saveRelationship(db, memorialId, 'child');
    expect(reload().organizerRelationship).toBe('child');
    expect(reload().intakeStep).toBe('relationship');
  });

  it('ignores a relationship that is not one of the offered chips', () => {
    saveRelationship(db, memorialId, 'sworn-enemy');
    expect(reload().organizerRelationship).toBeNull();
    // The question still counts as answered, so the wizard moves on.
    expect(reload().intakeStep).toBe('relationship');
  });

  it('stores the tradition and re-derives the pacing preset with it', () => {
    saveTradition(db, memorialId, 'catholic', NOW);
    expect(reload().traditionSlug).toBe('catholic');
    expect(reload().pacingPreset).toBe('days3to7');
  });

  it('treats "not sure" as neutral rather than as a religion', () => {
    saveTradition(db, memorialId, UNSURE_TRADITION, NOW);
    expect(reload().traditionSlug).toBe('secular');
    expect(reload().pacingPreset).toBe('flexible');
  });

  it('stores the service date, time and timezone together', () => {
    saveServiceDate(
      db,
      memorialId,
      { date: '2026-08-02', time: '14:30', timezone: 'Europe/Dublin' },
      NOW,
    );
    const row = reload();
    expect(row.timezone).toBe('Europe/Dublin');
    // 14:30 Irish summer time is 13:30 UTC.
    expect(row.serviceDate).toBe(Date.UTC(2026, 7, 2, 13, 30));
    expect(row.pacingPreset).toBe('days3to7');
  });

  it('stores the kind of gathering', () => {
    saveGathering(db, memorialId, 'celebration-of-life');
    expect(reload().gatheringKind).toBe('celebration-of-life');
  });
});

describe('skipping', () => {
  it('is a real answer: it advances without recording anything', () => {
    saveRelationship(db, memorialId, null);
    saveTradition(db, memorialId, null, NOW);
    saveServiceDate(db, memorialId, null, NOW);
    saveGathering(db, memorialId, null);
    const row = reload();
    expect(row.organizerRelationship).toBeNull();
    expect(row.serviceDate).toBeNull();
    expect(row.gatheringKind).toBeNull();
    expect(row.intakeStep).toBe('gathering');
  });

  it('never moves the progress marker backwards when a screen is revisited', () => {
    saveRelationship(db, memorialId, 'child');
    saveTradition(db, memorialId, 'secular', NOW);
    saveServiceDate(db, memorialId, { date: '2026-08-02' }, NOW);
    expect(reload().intakeStep).toBe('service-date');
    saveRelationship(db, memorialId, 'sibling');
    expect(reload().intakeStep).toBe('service-date');
    expect(reload().organizerRelationship).toBe('sibling');
  });
});

describe('what the screen shows back', () => {
  it('knows which questions have been put, skips included', () => {
    expect(hasAnsweredIntakeStep(reload(), 'relationship')).toBe(false);
    saveRelationship(db, memorialId, null);
    expect(hasAnsweredIntakeStep(reload(), 'relationship')).toBe(true);
    expect(hasAnsweredIntakeStep(reload(), 'tradition')).toBe(false);
  });

  it('marks a question answered without disturbing what autosave wrote', () => {
    saveServiceDate(db, memorialId, { date: '2026-08-02', time: '11:00' }, NOW);
    const stored = reload().serviceDate;
    markIntakeStep(db, memorialId, 'service-date');
    expect(reload().serviceDate).toBe(stored);
    expect(reload().intakeStep).toBe('service-date');
  });
});

describe('abandoning mid-wizard', () => {
  it('keeps every answer and resumes on the next unanswered question', () => {
    saveRelationship(db, memorialId, 'child');
    saveTradition(db, memorialId, 'catholic', NOW);
    // The tab is closed here. Nothing else happens.

    const resumed = reload();
    expect(resumed.organizerRelationship).toBe('child');
    expect(resumed.traditionSlug).toBe('catholic');
    expect(resumeIntakeStep(resumed)).toBe('service-date');
  });

  it('starts at the first question for a memorial nobody has answered yet', () => {
    expect(resumeIntakeStep(reload())).toBe('relationship');
  });

  it('sends a finished wizard to the dashboard instead', () => {
    saveGathering(db, memorialId, 'funeral');
    completeIntake(db, memorialId, NOW);
    expect(resumeIntakeStep(reload())).toBeUndefined();
  });
});

describe('completing the wizard', () => {
  it('derives pacing from the tradition and the date, and leaves draft behind', () => {
    saveTradition(db, memorialId, 'secular', NOW);
    saveServiceDate(db, memorialId, { date: '2026-07-29', time: '11:00' }, NOW);
    const done = completeIntake(db, memorialId, NOW);
    expect(done.pacingPreset).toBe('urgent24h');
    expect(done.status).toBe('active');
    expect(done.intakeCompletedAt).toBe(NOW);
  });

  it('is fine with a family who skipped everything', () => {
    const done = completeIntake(db, memorialId, NOW);
    expect(done.pacingPreset).toBe('flexible');
    expect(done.status).toBe('active');
  });
});

describe('parseServiceDate', () => {
  it('defaults to the early afternoon when only a date is given', () => {
    expect(parseServiceDate({ date: '2026-08-02', timezone: 'UTC' }).serviceDate).toBe(
      Date.UTC(2026, 7, 2, 13, 0),
    );
  });

  it('returns null for a half-typed or missing date rather than throwing', () => {
    for (const date of ['', '2026-08', 'tomorrow', undefined, null]) {
      expect(parseServiceDate({ date }).serviceDate).toBeNull();
    }
  });

  it('falls back to UTC for a timezone the platform does not know', () => {
    expect(parseServiceDate({ date: '2026-08-02', timezone: 'Mars/Olympus' }).timezone).toBe('UTC');
  });
});

describe('the options a person is offered', () => {
  it('covers the relationships people actually name, plus a way out', () => {
    const values = RELATIONSHIP_OPTIONS.map((o) => o.value);
    expect(values).toContain('spouse-partner');
    expect(values).toContain('other');
    expect(RELATIONSHIP_OPTIONS.every((o) => o.label.length > 0)).toBe(true);
  });

  it('offers every tradition pack plus "not sure"', () => {
    const choices = traditionChoices(listPacks());
    expect(choices).toHaveLength(listPacks().length + 1);
    expect(choices.at(-1)?.value).toBe(UNSURE_TRADITION);
    expect(choices.at(-1)?.label).toBe('Not sure, or none');
  });

  it('lets a family say they have not decided on the gathering', () => {
    expect(GATHERING_OPTIONS.map((o) => o.value)).toContain('undecided');
  });
});

describe('pacing stays correct as answers arrive in any order', () => {
  it('re-derives when the date is set after the tradition', () => {
    saveTradition(db, memorialId, 'jewish', NOW);
    expect(reload().pacingPreset).toBe('urgent24h');
    saveServiceDate(db, memorialId, { date: '2026-08-25' }, NOW);
    expect(reload().pacingPreset).toBe('flexible');
  });

  it('re-derives when the tradition is set after the date', () => {
    saveServiceDate(db, memorialId, { date: '2026-08-25' }, NOW);
    saveTradition(db, memorialId, 'jewish', NOW);
    expect(reload().pacingPreset).toBe('flexible');
    expect(NOW + 28 * MS_PER_DAY).toBeGreaterThan(NOW);
  });
});
