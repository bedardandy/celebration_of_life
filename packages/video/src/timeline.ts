/**
 * Turning a resolved timeline into frames.
 *
 * The timing engine in `@col/core` has already decided every second; this file
 * only converts those seconds to frames and works out, from the gaps between
 * slides, how long each dissolve is. Nothing here re-decides a duration — if it
 * did, the browser preview and the rendered file could disagree, and the whole
 * reason this product uses Remotion would be gone.
 */
import type { Edl, ResolvedTimeline, Slide, TransitionKind } from '@col/schemas';

export type SlidePlacement = {
  slideId: string;
  slide: Slide;
  /** Frame this slide's sequence starts on. */
  from: number;
  durationInFrames: number;
  /** How it arrives — taken from the previous slide's transitionOut. */
  transitionIn: { kind: TransitionKind; frames: number };
  /** How it leaves. The last slide always leaves to black. */
  transitionOut: { kind: TransitionKind; frames: number };
};

const NONE = { kind: 'cut' as const, frames: 0 };

export function framesFor(seconds: number, fps: number): number {
  return Math.max(0, Math.round(seconds * fps));
}

function transitionKindOf(slide: Slide | undefined): TransitionKind {
  if (!slide || slide.kind === 'closing') return 'cut';
  return slide.transitionOut.kind;
}

/**
 * Every slide, with the frames it occupies and the dissolves on either side.
 *
 * The overlap between two slides is read back out of the timeline rather than
 * recomputed: whatever the engine decided, down to the frame, is what gets
 * drawn.
 */
export function slidePlacements(edl: Edl, timeline: ResolvedTimeline): SlidePlacement[] {
  const fps = timeline.fps;
  const out: SlidePlacement[] = [];

  for (const [index, entry] of timeline.slides.entries()) {
    const slide = edl.slides[entry.slideId];
    if (!slide) continue;

    const from = framesFor(entry.startSec, fps);
    const durationInFrames = Math.max(1, framesFor(entry.durationSec, fps));

    const previous = timeline.slides[index - 1];
    const previousSlide = previous ? edl.slides[previous.slideId] : undefined;
    const overlapIn = previous
      ? Math.max(0, framesFor(previous.startSec + previous.durationSec, fps) - from)
      : 0;

    const next = timeline.slides[index + 1];
    const overlapOut = next
      ? Math.max(0, from + durationInFrames - framesFor(next.startSec, fps))
      : 0;

    out.push({
      slideId: entry.slideId,
      slide,
      from,
      durationInFrames,
      transitionIn:
        overlapIn > 0 ? { kind: transitionKindOf(previousSlide), frames: overlapIn } : NONE,
      transitionOut: overlapOut > 0 ? { kind: transitionKindOf(slide), frames: overlapOut } : NONE,
    });
  }

  return out;
}

/** Length of the whole thing, in frames. Never zero: Remotion refuses that. */
export function timelineDurationInFrames(timeline: ResolvedTimeline): number {
  return Math.max(1, framesFor(timeline.totalSec, timeline.fps));
}
