'use client';

/**
 * Watching a render without watching a render.
 *
 * The page is server-rendered and already correct when it loads; this only
 * refreshes it while something is actually being made, every few seconds, and
 * stops entirely when nothing is in flight. There is no spinner and no
 * countdown: the honest sentence comes from the server, from a measured
 * percentage, and this component's whole job is to fetch it again.
 *
 * It also stops polling when the tab is hidden — the promise on the screen is
 * that you can close this page, and a page that hammers the server in the
 * background is not keeping that promise.
 */
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** Slow enough to be invisible, fast enough that "done" appears promptly. */
export const POLL_MS = 5_000;

export function RenderWatch({ active }: { active: boolean }) {
  const router = useRouter();

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [active, router]);

  return null;
}
