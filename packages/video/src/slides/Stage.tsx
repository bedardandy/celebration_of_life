/**
 * The wrapper that makes one slide arrive and leave.
 *
 * Three transitions, and none of them are effects: a crossfade for the ordinary
 * case, a fade through black where the story takes a breath (into and out of a
 * quote card), and a straight cut where the music asks for one. Nothing wipes,
 * nothing spins, nothing flies. The room is already full of feeling and does
 * not need help from a transition library.
 *
 * A crossfade is achieved by overlapping Sequences: the arriving slide is
 * painted on top of the one still on screen and fades up. A fade through black
 * is the same two ramps, but pushed into opposite halves of the overlap, so the
 * background shows through in between.
 */
import type { ReactNode } from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import type { TransitionKind } from '@col/schemas';
import { TRIBUTE_THEME } from '../theme';

export type StageProps = {
  durationInFrames: number;
  transitionIn: { kind: TransitionKind; frames: number };
  transitionOut: { kind: TransitionKind; frames: number };
  children: ReactNode;
};

export function stageOpacity(
  frame: number,
  props: Pick<StageProps, 'durationInFrames' | 'transitionIn' | 'transitionOut'>,
): number {
  const { durationInFrames, transitionIn, transitionOut } = props;

  // Arriving. A fade through black waits out the first half of the overlap, so
  // the slide it replaces has somewhere to go.
  let opacity = 1;
  if (transitionIn.frames > 0 && transitionIn.kind !== 'cut') {
    const start = transitionIn.kind === 'fadeThroughBlack' ? transitionIn.frames / 2 : 0;
    opacity = interpolate(frame, [start, transitionIn.frames], [0, 1], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
  }

  // Leaving. Only a fade through black dims on the way out — under a crossfade
  // the arriving slide is already covering this one, and dimming both at once
  // is what makes a dissolve look like a smear.
  if (transitionOut.frames > 0 && transitionOut.kind === 'fadeThroughBlack') {
    const half = transitionOut.frames / 2;
    opacity = Math.min(
      opacity,
      interpolate(frame, [durationInFrames - transitionOut.frames, durationInFrames - half], [1, 0], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      }),
    );
  }

  return opacity;
}

export function Stage({ children, ...props }: StageProps) {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill
      style={{
        backgroundColor: TRIBUTE_THEME.background,
        opacity: stageOpacity(frame, props),
      }}
    >
      {children}
    </AbsoluteFill>
  );
}
