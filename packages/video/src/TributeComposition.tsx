import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import type { Edl } from '@col/schemas';
import { firstTitleSlide } from './defaults';
import { TRIBUTE_THEME } from './theme';

/**
 * The one composition that is both the browser preview (@remotion/player) and
 * the rendered MP4. Preview and file are frame-identical because they are
 * literally the same component — that is the whole reason Remotion is here.
 *
 * Phase 0 renders only the opening title card. Photo slides, Ken Burns,
 * transitions and captions arrive in Phase 4; the props contract does not
 * change when they do.
 */
export type TributeCompositionProps = {
  edl: Edl;
  /**
   * assetId → URL the renderer/browser can fetch. Blobs are private, so the app
   * mints authorised URLs and hands them in; the composition never guesses a
   * path of its own.
   */
  assetUrlMap: Record<string, string>;
};

export function TributeComposition({ edl }: TributeCompositionProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const title = firstTitleSlide(edl);
  const name = title?.text ?? 'In loving memory';
  const subtext = title?.subtext;

  // A slow, single fade. Nothing bounces, nothing whooshes.
  const opacity = interpolate(frame, [0, Math.round(fps * 1.2)], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: TRIBUTE_THEME.background,
        color: TRIBUTE_THEME.foreground,
        fontFamily: TRIBUTE_THEME.serif,
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: '0 8%',
      }}
    >
      <div style={{ opacity }}>
        <h1
          style={{
            fontSize: 96,
            fontWeight: 400,
            lineHeight: 1.15,
            letterSpacing: '0.01em',
            margin: 0,
          }}
        >
          {name}
        </h1>
        {subtext ? (
          <p
            style={{
              fontSize: 40,
              fontWeight: 400,
              color: TRIBUTE_THEME.muted,
              margin: '32px 0 0',
            }}
          >
            {subtext}
          </p>
        ) : null}
      </div>
    </AbsoluteFill>
  );
}

export default TributeComposition;
