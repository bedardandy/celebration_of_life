'use client';

/**
 * The waiting screen refreshes itself so nobody has to work out that they are
 * meant to press reload. It polls gently — this is a job that takes a minute or
 * two, not a progress bar — and stops after a few minutes rather than hammering
 * a queue that has clearly gone wrong.
 */
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export const POLL_MS = 4_000;
export const GIVE_UP_MS = 5 * 60_000;

export function WaitingRefresh() {
  const router = useRouter();

  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > GIVE_UP_MS) {
        clearInterval(timer);
        return;
      }
      router.refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [router]);

  return null;
}
