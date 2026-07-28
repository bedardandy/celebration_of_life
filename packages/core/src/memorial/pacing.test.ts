import { describe, expect, it } from 'vitest';
import { getPack } from '@col/tradition-packs';
import { MS_PER_DAY, dashboardBanner, derivePacingPreset, formatServiceDate } from './pacing';

const NOW = Date.UTC(2026, 6, 28, 9, 0, 0);
const NEXT_STEP = 'The most helpful next step is gathering a few photos.';

describe('derivePacingPreset', () => {
  it('falls back to the tradition pack when no date is known', () => {
    expect(derivePacingPreset(getPack('secular'), null, NOW)).toBe('flexible');
    expect(derivePacingPreset(getPack('catholic'), null, NOW)).toBe('days3to7');
    expect(derivePacingPreset(getPack('jewish'), null, NOW)).toBe('urgent24h');
  });

  it('lets a known date override the tradition, in both directions', () => {
    // A secular celebration tomorrow is urgent even though the pack is flexible.
    expect(derivePacingPreset(getPack('secular'), NOW + MS_PER_DAY, NOW)).toBe('urgent24h');
    // A Jewish family's shloshim gathering three weeks out is not a 24h rush.
    expect(derivePacingPreset(getPack('jewish'), NOW + 21 * MS_PER_DAY, NOW)).toBe('flexible');
  });

  it('reads the whole band between one day and one week as days3to7', () => {
    expect(derivePacingPreset(getPack('secular'), NOW + 2 * MS_PER_DAY, NOW)).toBe('days3to7');
    expect(derivePacingPreset(getPack('secular'), NOW + 7 * MS_PER_DAY, NOW)).toBe('days3to7');
    expect(derivePacingPreset(getPack('secular'), NOW + 9 * MS_PER_DAY, NOW)).toBe('flexible');
  });

  it('treats a date already past as urgent, not as flexible', () => {
    expect(derivePacingPreset(getPack('secular'), NOW - MS_PER_DAY, NOW)).toBe('urgent24h');
  });

  it('keeps a memorial-cycle pack on its cycle for distant dates', () => {
    const cyclePack = { pacingPreset: 'memorial-cycle' } as const;
    expect(derivePacingPreset(cyclePack, NOW + 40 * MS_PER_DAY, NOW)).toBe('memorial-cycle');
    expect(derivePacingPreset(cyclePack, NOW + MS_PER_DAY, NOW)).toBe('urgent24h');
  });
});

describe('dashboardBanner', () => {
  it('says the service is tomorrow, then names one thing', () => {
    const banner = dashboardBanner({
      pacingPreset: 'urgent24h',
      serviceDate: NOW + 0.9 * MS_PER_DAY,
      now: NOW,
      nextStep: NEXT_STEP,
    });
    expect(banner.tone).toBe('urgent');
    expect(banner.headline).toBe('The service is tomorrow.');
    expect(banner.nextStep).toBe(NEXT_STEP);
  });

  it('counts days plainly in the week before', () => {
    const banner = dashboardBanner({
      pacingPreset: 'days3to7',
      serviceDate: NOW + 5 * MS_PER_DAY,
      now: NOW,
      nextStep: NEXT_STEP,
    });
    expect(banner.headline).toBe('The service is in 5 days.');
    expect(banner.tone).toBe('soon');
  });

  it('reassures rather than counts when the date is far off', () => {
    const banner = dashboardBanner({
      pacingPreset: 'flexible',
      serviceDate: NOW + 21 * MS_PER_DAY,
      now: NOW,
      nextStep: NEXT_STEP,
    });
    expect(banner.headline).toBe('The service is in about 3 weeks. There is time.');
  });

  it('lifts the deadline entirely once the service has passed', () => {
    const banner = dashboardBanner({
      pacingPreset: 'urgent24h',
      serviceDate: NOW - 3 * MS_PER_DAY,
      now: NOW,
      nextStep: NEXT_STEP,
    });
    expect(banner.tone).toBe('open');
    expect(banner.headline).toMatch(/no deadline/i);
  });

  it('has something calm to say when no date is known, for every preset', () => {
    for (const preset of ['urgent24h', 'days3to7', 'memorial-cycle', 'flexible'] as const) {
      const banner = dashboardBanner({ pacingPreset: preset, now: NOW, nextStep: NEXT_STEP });
      expect(banner.headline.trim().length).toBeGreaterThan(0);
      expect(banner.nextStep).toBe(NEXT_STEP);
    }
  });

  it('is never alarmist', () => {
    const banners = [
      dashboardBanner({
        pacingPreset: 'urgent24h',
        serviceDate: NOW + 3600_000,
        now: NOW,
        nextStep: NEXT_STEP,
      }),
      dashboardBanner({ pacingPreset: 'flexible', now: NOW, nextStep: NEXT_STEP }),
    ];
    for (const banner of banners) {
      expect(banner.headline).not.toMatch(/!|hurry|urgent|deadline|running out|only/i);
    }
  });
});

describe('formatServiceDate', () => {
  it('spells the date out, with the memorial timezone', () => {
    const at = Date.UTC(2026, 7, 2, 13, 0, 0);
    expect(formatServiceDate(at, 'UTC')).toMatch(/Sunday/);
    expect(formatServiceDate(at, 'UTC')).toMatch(/2 August/);
  });

  it('falls back rather than throwing on an unknown timezone', () => {
    expect(() => formatServiceDate(Date.UTC(2026, 7, 2), 'Mars/Olympus')).not.toThrow();
  });
});
