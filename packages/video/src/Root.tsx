import { Composition, registerRoot } from 'remotion';
import { TributeComposition } from './TributeComposition';
import {
  DEFAULT_DURATION_IN_FRAMES,
  DEFAULT_EDL,
  TRIBUTE_COMPOSITION_ID,
  TRIBUTE_FPS,
  TRIBUTE_HEIGHT,
  TRIBUTE_WIDTH,
} from './defaults';

/**
 * Remotion entry point (`remotion studio src/Root.tsx`, and the bundler target
 * for the render worker). Kept separate from src/index.ts so importing the
 * composition from the web app does not run registerRoot().
 */
export function RemotionRoot() {
  return (
    <Composition
      id={TRIBUTE_COMPOSITION_ID}
      component={TributeComposition}
      durationInFrames={DEFAULT_DURATION_IN_FRAMES}
      fps={TRIBUTE_FPS}
      width={TRIBUTE_WIDTH}
      height={TRIBUTE_HEIGHT}
      defaultProps={{ edl: DEFAULT_EDL, assetUrlMap: {} }}
    />
  );
}

registerRoot(RemotionRoot);
