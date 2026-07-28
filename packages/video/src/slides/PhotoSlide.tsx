/**
 * A photograph, full screen, moving almost imperceptibly.
 *
 * Two things here are about rooms rather than about code. The Ken Burns move is
 * a slow push of a few percent — enough that a still photograph on a projector
 * does not read as a frozen screen, never enough that anyone watching notices
 * the camera. And a portrait photograph gets a blurred, dimmed copy of itself
 * behind it instead of two black bars, because half the photographs a family
 * finds on a phone are portrait and a slideshow of letterboxed pillars looks
 * like a mistake nobody had time to fix.
 */
import { AbsoluteFill, Easing, Img, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import type { Easing as EasingName, PhotoSlide as PhotoSlideType, Rect } from '@col/schemas';
import { TRIBUTE_THEME } from '../theme';

export type PhotoSlideProps = {
  slide: PhotoSlideType;
  durationInFrames: number;
  /** Resolved URL for this asset. Missing means the picture is still arriving. */
  src?: string;
};

/** How much wider than the frame a photograph must be to count as landscape. */
export const PORTRAIT_THRESHOLD = 0.98;

const EASINGS: Record<EasingName, (t: number) => number> = {
  linear: (t) => t,
  easeIn: Easing.in(Easing.ease),
  easeOut: Easing.out(Easing.ease),
  easeInOut: Easing.inOut(Easing.ease),
};

/**
 * The CSS transform that puts `rect` — a window on the source image, in 0..1
 * space — full frame.
 *
 * Scale comes from the width alone and the height only recentres, so a
 * photograph is never stretched to fit a frame it was not shaped for. Written
 * as translate-then-scale because CSS applies the rightmost function first.
 */
export function transformForRect(rect: Rect, width: number, height: number): string {
  const scale = 1 / Math.max(0.01, rect.w);
  const centreX = rect.x + rect.w / 2;
  const centreY = rect.y + rect.h / 2;
  const tx = scale * (0.5 - centreX) * width;
  const ty = scale * (0.5 - centreY) * height;
  return `translate(${tx.toFixed(3)}px, ${ty.toFixed(3)}px) scale(${scale.toFixed(5)})`;
}

/** Where the move has got to on this frame, 0 at the start and 1 at the end. */
export function kenBurnsRect(slide: PhotoSlideType, frame: number, durationInFrames: number): Rect {
  const easing = EASINGS[slide.kenBurns.easing] ?? EASINGS.easeInOut;
  const at = (from: number, to: number) =>
    interpolate(frame, [0, Math.max(1, durationInFrames - 1)], [from, to], {
      easing,
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
  const { from, to } = slide.kenBurns;
  return { x: at(from.x, to.x), y: at(from.y, to.y), w: at(from.w, to.w), h: at(from.h, to.h) };
}

export function isPortrait(slide: PhotoSlideType, frameAspect: number): boolean {
  if (slide.sourceAspect == null) return false;
  return slide.sourceAspect < frameAspect * PORTRAIT_THRESHOLD;
}

export function PhotoSlide({ slide, durationInFrames, src }: PhotoSlideProps) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const rect = kenBurnsRect(slide, frame, durationInFrames);
  const transform = transformForRect(rect, width, height);
  const portrait = isPortrait(slide, width / height);

  return (
    <AbsoluteFill style={{ backgroundColor: TRIBUTE_THEME.background, overflow: 'hidden' }}>
      {src && portrait ? (
        <AbsoluteFill style={{ overflow: 'hidden' }}>
          <Img
            src={src}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              // Scaled past the edges so the blur has nothing to feather into.
              transform: 'scale(1.15)',
              filter: 'blur(48px) brightness(0.5) saturate(0.85)',
            }}
          />
        </AbsoluteFill>
      ) : null}

      {src ? (
        <AbsoluteFill style={{ overflow: 'hidden' }}>
          <Img
            src={src}
            style={{
              width: '100%',
              height: '100%',
              objectFit: portrait ? 'contain' : 'cover',
              transform,
              transformOrigin: 'center center',
            }}
          />
        </AbsoluteFill>
      ) : (
        <AbsoluteFill
          style={{
            alignItems: 'center',
            justifyContent: 'center',
            color: TRIBUTE_THEME.muted,
            fontFamily: TRIBUTE_THEME.sans,
            fontSize: Math.round(height * 0.025),
          }}
        >
          This photograph is still arriving
        </AbsoluteFill>
      )}

      {slide.caption ? (
        <Caption text={slide.caption.text} position={slide.caption.position} />
      ) : null}
    </AbsoluteFill>
  );
}

function Caption({ text, position }: { text: string; position: 'top' | 'bottom' | 'lower-third' }) {
  const { height, width } = useVideoConfig();
  const vertical =
    position === 'top'
      ? { top: '7%' }
      : position === 'bottom'
        ? { bottom: '7%' }
        : { bottom: '13%' };

  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          left: '8%',
          right: '8%',
          ...vertical,
          textAlign: 'center',
          fontFamily: TRIBUTE_THEME.sans,
          fontSize: Math.round(height * 0.033),
          lineHeight: 1.35,
          color: TRIBUTE_THEME.foreground,
          // A soft plate rather than a hard bar: readable over a bright sky
          // without putting a graphic-design element on someone's wedding photo.
          textShadow: `0 ${Math.round(width * 0.001)}px ${Math.round(width * 0.008)}px rgba(0,0,0,0.75)`,
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
}
