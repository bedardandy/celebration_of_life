'use client';

/**
 * The slideshow, playing in the browser, from the same component that renders
 * the file. Preview and MP4 are frame-identical because they are the same code
 * — which is the difference between "this is roughly what you will get" and
 * "this is what you will get".
 *
 * Nothing auto-plays. A tribute video that starts by itself while someone is
 * reading the page is a small cruelty, and this product does not do it.
 */
import { useCallback, useRef } from 'react';
import { Player, type PlayerRef } from '@remotion/player';
import { TributeComposition, type TributeCompositionProps } from '@col/video';
import type { Edl, ResolvedTimeline } from '@col/schemas';
import styles from './preview.module.css';

export type PreviewPlayerProps = {
  edl: Edl;
  timeline: ResolvedTimeline;
  assetUrlMap: Record<string, string>;
  /** Bumped on every edit, so React remounts the player with fresh props. */
  edlVersion: number;
};

export function PreviewPlayer({ edl, timeline, assetUrlMap, edlVersion }: PreviewPlayerProps) {
  const player = useRef<PlayerRef>(null);
  const fps = timeline.fps || 30;
  const durationInFrames = Math.max(1, Math.round(timeline.totalSec * fps));

  const jump = useCallback(
    (seconds: number) => {
      player.current?.seekTo(Math.round(seconds * fps));
    },
    [fps],
  );

  const inputProps: TributeCompositionProps = {
    edl,
    resolvedTimeline: timeline,
    assetUrlMap,
  };

  return (
    <div>
      <Player
        // The version is part of the key so an edit replaces the player rather
        // than leaving it holding a timeline that no longer exists.
        key={`${timeline.cut}-${edlVersion}`}
        ref={player}
        component={TributeComposition}
        inputProps={inputProps}
        durationInFrames={durationInFrames}
        fps={fps}
        compositionWidth={edl.resolution.w}
        compositionHeight={edl.resolution.h}
        style={{ width: '100%', borderRadius: 10, overflow: 'hidden' }}
        controls
        doubleClickToFullscreen
        acknowledgeRemotionLicense
      />

      {timeline.chapters.length > 1 ? (
        <nav className={styles.chapters} aria-label="Jump to a chapter">
          {timeline.chapters.map((chapter) => (
            <button
              key={chapter.id}
              type="button"
              className={styles.chapterButton}
              onClick={() => jump(chapter.startSec)}
            >
              {chapter.title}
            </button>
          ))}
        </nav>
      ) : null}
    </div>
  );
}
