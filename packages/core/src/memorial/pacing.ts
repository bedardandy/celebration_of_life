/**
 * Pacing: how much time this family actually has.
 *
 * The preset is derived, never guessed at in a component. Two inputs: the
 * tradition pack (data, so no `if (jewish)` anywhere) and the service date if
 * one is known. A known date always wins, because a Jewish family planning a
 * shloshim gathering three weeks out is not in a 24-hour rush, and a secular
 * family whose celebration is tomorrow is.
 */
import type { PacingPreset, TraditionPack } from '@col/schemas';

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole-ish days until the service; negative once it has passed. */
export function daysUntil(serviceDate: number, now: number = Date.now()): number {
  return (serviceDate - now) / MS_PER_DAY;
}

export function derivePacingPreset(
  pack: Pick<TraditionPack, 'pacingPreset'>,
  serviceDate: number | null | undefined,
  now: number = Date.now(),
): PacingPreset {
  if (serviceDate == null) return pack.pacingPreset;
  const days = daysUntil(serviceDate, now);
  if (days <= 1.5) return 'urgent24h';
  if (days <= 8) return 'days3to7';
  // Beyond a week, only traditions with a formal remembrance cycle keep theirs.
  return pack.pacingPreset === 'memorial-cycle' ? 'memorial-cycle' : 'flexible';
}

export type BannerTone = 'urgent' | 'soon' | 'steady' | 'open';

export type DeadlineBanner = {
  tone: BannerTone;
  /** One sentence about time. Never a countdown, never an exclamation mark. */
  headline: string;
  /** One sentence naming the single most useful next thing. */
  nextStep: string;
};

export type BannerInput = {
  pacingPreset: PacingPreset;
  serviceDate?: number | null;
  now?: number;
  /** What the dashboard would suggest doing next, in plain words. */
  nextStep: string;
};

/**
 * Deadline-aware, never alarmist. The rule we hold to: name the time, then name
 * one thing. No "hurry", no "only N hours left", no red.
 */
export function dashboardBanner(input: BannerInput): DeadlineBanner {
  const now = input.now ?? Date.now();
  const nextStep = input.nextStep;

  if (input.serviceDate != null) {
    const days = daysUntil(input.serviceDate, now);
    if (days < -0.5) {
      return {
        tone: 'open',
        headline: 'The service has passed. There is no deadline on any of this now.',
        nextStep,
      };
    }
    if (days <= 1) {
      return {
        tone: 'urgent',
        headline: 'The service is tomorrow.',
        nextStep,
      };
    }
    if (days <= 2) {
      return { tone: 'urgent', headline: 'The service is in two days.', nextStep };
    }
    if (days <= 7) {
      return {
        tone: 'soon',
        headline: `The service is in ${Math.round(days)} days.`,
        nextStep,
      };
    }
    return {
      tone: 'steady',
      headline: `The service is in about ${Math.round(days / 7)} ${
        Math.round(days / 7) === 1 ? 'week' : 'weeks'
      }. There is time.`,
      nextStep,
    };
  }

  if (input.pacingPreset === 'urgent24h') {
    return {
      tone: 'soon',
      headline: 'The first day or two is for the funeral itself, not for this.',
      nextStep,
    };
  }
  if (input.pacingPreset === 'memorial-cycle') {
    return {
      tone: 'steady',
      headline: 'This unfolds over weeks, so nothing here has to happen today.',
      nextStep,
    };
  }
  if (input.pacingPreset === 'days3to7') {
    return {
      tone: 'soon',
      headline: 'Most families have about a week. That is enough.',
      nextStep,
    };
  }
  return {
    tone: 'open',
    headline: 'No date yet, so there is no rush.',
    nextStep,
  };
}

/** "Sunday 3 August, 2:00 pm" — long, unambiguous, no clever abbreviations. */
export function formatServiceDate(serviceDate: number, timezone = 'UTC', locale = 'en-GB'): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: timezone,
    }).format(new Date(serviceDate));
  } catch {
    return new Intl.DateTimeFormat(locale, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(serviceDate));
  }
}
