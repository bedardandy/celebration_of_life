import { Composition, registerRoot } from 'remotion';
import { TributeComposition, type TributeCompositionProps } from './TributeComposition';
import { timelineDurationInFrames } from './timeline';
import {
  DEFAULT_DURATION_IN_FRAMES,
  DEFAULT_EDL,
  DEFAULT_TIMELINE,
  TRIBUTE_COMPOSITION_ID,
  TRIBUTE_FPS,
  TRIBUTE_HEIGHT,
  TRIBUTE_WIDTH,
} from './defaults';

/**
 * Remotion entry point (`remotion studio src/Root.tsx`, and the bundler target
 * for the render worker). Kept separate from src/index.ts so importing the
 * composition from the web app does not run registerRoot().
 *
 * The length and the frame size come from the props rather than from this file:
 * a five-minute service cut and an eight-minute family cut are the same
 * composition asked a different question, and `calculateMetadata` is where that
 * question gets answered.
 */
export function tributeMetadata({ props }: { props: TributeCompositionProps }) {
  const timeline = props.resolvedTimeline ?? DEFAULT_TIMELINE;
  return {
    durationInFrames: timelineDurationInFrames(timeline),
    fps: timeline.fps || props.edl.fps || TRIBUTE_FPS,
    width: props.edl.resolution?.w ?? TRIBUTE_WIDTH,
    height: props.edl.resolution?.h ?? TRIBUTE_HEIGHT,
  };
}

export function RemotionRoot() {
  return (
    <Composition
      id={TRIBUTE_COMPOSITION_ID}
      component={TributeComposition}
      durationInFrames={DEFAULT_DURATION_IN_FRAMES}
      fps={TRIBUTE_FPS}
      width={TRIBUTE_WIDTH}
      height={TRIBUTE_HEIGHT}
      defaultProps={{
        edl: DEFAULT_EDL,
        resolvedTimeline: DEFAULT_TIMELINE,
        assetUrlMap: {},
      }}
      calculateMetadata={tributeMetadata}
    />
  );
}

registerRoot(RemotionRoot);
