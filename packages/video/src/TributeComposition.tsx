import { AbsoluteFill, Sequence, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import type { Edl, ResolvedTimeline } from '@col/schemas';
import { DEFAULT_TIMELINE } from './defaults';
import { slidePlacements, type SlidePlacement } from './timeline';
import { ClosingCard, QuoteCard, TitleCard } from './slides/Cards';
import { PhotoSlide } from './slides/PhotoSlide';
import { Stage } from './slides/Stage';
import { TRIBUTE_THEME } from './theme';

/**
 * The one composition that is both the browser preview (@remotion/player) and
 * the rendered MP4. Preview and file are frame-identical because they are
 * literally the same component — that is the whole reason Remotion is here.
 *
 * It is a pure function of its props and `useCurrentFrame()`. No dates, no
 * random, no measuring: frame 900 looks the same on a laptop in a kitchen and
 * on a render worker three days later, which is what lets a family trust that
 * what they approved is what will play.
 */
export type TributeCompositionProps = {
  edl: Edl;
  /**
   * Where every slide lands on the clock, for the cut being watched. Computed
   * by the timing engine in `@col/core` and handed in: this component never
   * decides a duration of its own.
   */
  resolvedTimeline: ResolvedTimeline;
  /**
   * assetId → URL the renderer/browser can fetch. Blobs are private, so the app
   * mints authorised URLs and hands them in; the composition never guesses a
   * path of its own.
   */
  assetUrlMap: Record<string, string>;
};

/** Seconds of black before the first slide. Long enough for a room to settle. */
export const OPENING_FADE_SEC = 1;

export function TributeComposition({
  edl,
  resolvedTimeline,
  assetUrlMap,
}: TributeCompositionProps) {
  const { fps } = useVideoConfig();
  const timeline = resolvedTimeline ?? DEFAULT_TIMELINE;
  const placements = slidePlacements(edl, timeline);

  return (
    <AbsoluteFill style={{ backgroundColor: TRIBUTE_THEME.background }}>
      {placements.map((placement) => (
        <Sequence
          key={placement.slideId}
          from={placement.from}
          durationInFrames={placement.durationInFrames}
          name={placement.slideId}
        >
          <Stage
            durationInFrames={placement.durationInFrames}
            transitionIn={placement.transitionIn}
            transitionOut={placement.transitionOut}
          >
            <SlideBody placement={placement} assetUrlMap={assetUrlMap} />
          </Stage>
        </Sequence>
      ))}
      <OpeningFade fps={fps} />
    </AbsoluteFill>
  );
}

function SlideBody({
  placement,
  assetUrlMap,
}: {
  placement: SlidePlacement;
  assetUrlMap: Record<string, string>;
}) {
  const { slide, durationInFrames } = placement;
  switch (slide.kind) {
    case 'title':
      return <TitleCard slide={slide} />;
    case 'quote':
      return <QuoteCard slide={slide} />;
    case 'closing':
      return <ClosingCard slide={slide} durationInFrames={durationInFrames} />;
    case 'photo':
      return (
        <PhotoSlide
          slide={slide}
          durationInFrames={durationInFrames}
          {...(assetUrlMap[slide.assetId] ? { src: assetUrlMap[slide.assetId] as string } : {})}
        />
      );
  }
}

/** A held black frame at the very top, so the video does not start mid-thought. */
function OpeningFade({ fps }: { fps: number }) {
  const frame = useCurrentFrame();
  const frames = Math.max(1, Math.round(fps * OPENING_FADE_SEC));
  if (frame >= frames) return null;
  const opacity = interpolate(frame, [0, frames], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <AbsoluteFill
      style={{ backgroundColor: TRIBUTE_THEME.background, opacity, pointerEvents: 'none' }}
    />
  );
}

export default TributeComposition;
