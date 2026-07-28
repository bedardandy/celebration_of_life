export {
  TributeComposition,
  OPENING_FADE_SEC,
  type TributeCompositionProps,
} from './TributeComposition';
export {
  DEFAULT_DURATION_IN_FRAMES,
  DEFAULT_EDL,
  DEFAULT_TIMELINE,
  TRIBUTE_COMPOSITION_ID,
  TRIBUTE_FPS,
  TRIBUTE_HEIGHT,
  TRIBUTE_WIDTH,
  firstTitleSlide,
} from './defaults';
export {
  framesFor,
  slidePlacements,
  timelineDurationInFrames,
  type SlidePlacement,
} from './timeline';
export { Stage, stageOpacity, type StageProps } from './slides/Stage';
export {
  PhotoSlide,
  PORTRAIT_THRESHOLD,
  isPortrait,
  kenBurnsRect,
  transformForRect,
  type PhotoSlideProps,
} from './slides/PhotoSlide';
export { CARD_FADE_SEC, ClosingCard, QuoteCard, TitleCard, cardEntrance } from './slides/Cards';
export { TRIBUTE_THEME, type TributeTheme } from './theme';

// Deliberately NOT re-exported here: `./browser` reads the filesystem, and this
// entry point is imported by the browser preview. Node-side callers (the render
// worker, the micro-render test) import '@col/video/browser' directly.
