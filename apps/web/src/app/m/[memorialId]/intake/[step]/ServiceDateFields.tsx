'use client';

/**
 * The one intake screen with fields rather than chips.
 *
 * It saves on every change — no Save button, and no way to lose a date by
 * closing the tab after typing it. The quiet "Saved just now" line is the only
 * acknowledgement, which is all it should be.
 */
import { useEffect, useState, useTransition } from 'react';
import { step } from '@/components/StepScreen';
import { SavedIndicator, type SaveState } from '@/components/SavedIndicator';
import { saveServiceDateAction } from '../actions';

export type ServiceDateFieldsProps = {
  memorialId: string;
  serviceDate: number | null;
  timezone: string;
};

export function ServiceDateFields({ memorialId, serviceDate, timezone }: ServiceDateFieldsProps) {
  const initial = splitServiceDate(serviceDate, timezone);
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);
  const [zone, setZone] = useState(timezone);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [, startTransition] = useTransition();

  // On a device we have not seen before, offer its own timezone rather than UTC.
  useEffect(() => {
    if (zone !== 'UTC') return;
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (local && local !== 'UTC') setZone(local);
  }, [zone]);

  function save(next: { date?: string; time?: string; zone?: string }) {
    const payload = {
      memorialId,
      date: next.date ?? date,
      time: next.time ?? time,
      timezone: next.zone ?? zone,
    };
    setSaveState('saving');
    startTransition(async () => {
      await saveServiceDateAction(payload);
      setSaveState('saved');
    });
  }

  return (
    <div>
      <div className={step.field}>
        <label htmlFor="serviceDate">Date of the service</label>
        <input
          id="serviceDate"
          type="date"
          value={date}
          onChange={(event) => {
            setDate(event.target.value);
            save({ date: event.target.value });
          }}
        />
      </div>

      <div className={step.field}>
        <label htmlFor="serviceTime">Time, if you know it</label>
        <input
          id="serviceTime"
          type="time"
          value={time}
          onChange={(event) => {
            setTime(event.target.value);
            save({ time: event.target.value });
          }}
        />
        <p className={step.fieldHint}>Leave this if it is not settled. We will assume afternoon.</p>
      </div>

      <input type="hidden" name="timezone" value={zone} readOnly />
      <p className={step.fieldHint}>Times are shown in {zone.replace(/_/g, ' ')}.</p>
      <SavedIndicator state={saveState} />
    </div>
  );
}

/** Splits a stored instant back into the two fields, in the memorial's zone. */
export function splitServiceDate(
  serviceDate: number | null,
  timezone: string,
): { date: string; time: string } {
  if (serviceDate == null) return { date: '', time: '' };
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(serviceDate));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    const hour = get('hour') === '24' ? '00' : get('hour');
    return {
      date: `${get('year')}-${get('month')}-${get('day')}`,
      time: `${hour}:${get('minute')}`,
    };
  } catch {
    return { date: '', time: '' };
  }
}
