/**
 * The three cards: the one at the front, the ones in the middle, the one at the
 * end.
 *
 * They are typographic and nothing else. A serif, generously spaced, on the
 * warm dark the whole video sits on. The only movement is a gentle rise as the
 * text arrives, which is there because text that simply appears reads as a
 * PowerPoint and text that slides in from the side reads as a commercial.
 */
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import type { ClosingSlide, QuoteSlide, TitleSlide } from '@col/schemas';
import { TRIBUTE_THEME } from '../theme';

/** Seconds the text takes to arrive. Slow, and the same on every card. */
export const CARD_FADE_SEC = 1.2;

export function cardEntrance(frame: number, fps: number): { opacity: number; lift: number } {
  const frames = Math.max(1, Math.round(fps * CARD_FADE_SEC));
  const opacity = interpolate(frame, [0, frames], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const lift = interpolate(frame, [0, frames], [14, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return { opacity, lift };
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <AbsoluteFill
      style={{
        backgroundColor: TRIBUTE_THEME.background,
        color: TRIBUTE_THEME.foreground,
        fontFamily: TRIBUTE_THEME.serif,
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: '0 9%',
      }}
    >
      {children}
    </AbsoluteFill>
  );
}

export function TitleCard({ slide }: { slide: TitleSlide }) {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const { opacity, lift } = cardEntrance(frame, fps);

  return (
    <Centered>
      <div style={{ opacity, transform: `translateY(${lift.toFixed(2)}px)` }}>
        <h1
          style={{
            fontSize: Math.round(height * 0.089),
            fontWeight: 400,
            lineHeight: 1.15,
            letterSpacing: '0.01em',
            margin: 0,
          }}
        >
          {slide.text}
        </h1>
        {slide.subtext ? (
          <p
            style={{
              fontSize: Math.round(height * 0.037),
              fontWeight: 400,
              color: TRIBUTE_THEME.muted,
              margin: `${Math.round(height * 0.03)}px 0 0`,
            }}
          >
            {slide.subtext}
          </p>
        ) : null}
      </div>
    </Centered>
  );
}

/**
 * Somebody's words, on screen, exactly as they wrote them. The attribution is
 * smaller and quieter but always present — an unattributed memory at a funeral
 * reads as something the software made up, which is the one thing it must never
 * look like.
 */
export function QuoteCard({ slide }: { slide: QuoteSlide }) {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const { opacity, lift } = cardEntrance(frame, fps);
  const long = slide.text.length > 180;

  return (
    <Centered>
      <div style={{ opacity, transform: `translateY(${lift.toFixed(2)}px)`, maxWidth: '78%' }}>
        <p
          style={{
            fontSize: Math.round(height * (long ? 0.042 : 0.052)),
            fontWeight: 400,
            lineHeight: 1.45,
            fontStyle: 'italic',
            margin: 0,
          }}
        >
          {slide.text}
        </p>
        <p
          style={{
            fontFamily: TRIBUTE_THEME.sans,
            fontSize: Math.round(height * 0.026),
            letterSpacing: '0.04em',
            color: TRIBUTE_THEME.muted,
            margin: `${Math.round(height * 0.035)}px 0 0`,
          }}
        >
          {slide.attribution}
        </p>
      </div>
    </Centered>
  );
}

/**
 * The last thing on screen, and the only place the video fades all the way out.
 * The room needs a moment before the lights come up; the fade is that moment.
 */
export function ClosingCard({
  slide,
  durationInFrames,
}: {
  slide: ClosingSlide;
  durationInFrames: number;
}) {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const { opacity, lift } = cardEntrance(frame, fps);
  const outFrames = Math.max(1, Math.round(fps * 1.6));
  const fadeOut = interpolate(frame, [durationInFrames - outFrames, durationInFrames], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={{ backgroundColor: TRIBUTE_THEME.background }}>
      <Centered>
        <div
          style={{
            opacity: Math.min(opacity, fadeOut),
            transform: `translateY(${lift.toFixed(2)}px)`,
          }}
        >
          <h2
            style={{
              fontSize: Math.round(height * 0.062),
              fontWeight: 400,
              lineHeight: 1.2,
              margin: 0,
            }}
          >
            {slide.line1}
          </h2>
          {slide.line2 ? (
            <p
              style={{
                fontSize: Math.round(height * 0.031),
                color: TRIBUTE_THEME.muted,
                margin: `${Math.round(height * 0.028)}px 0 0`,
              }}
            >
              {slide.line2}
            </p>
          ) : null}
        </div>
      </Centered>
    </AbsoluteFill>
  );
}
