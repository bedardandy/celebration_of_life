/**
 * Visual defaults for the tribute video.
 *
 * Warm and dim rather than black and clinical: this plays in a room full of
 * people who are already sad, often on a projector that washes out. Full black
 * behind white serif type looks like a news broadcast; a deep warm brown-grey
 * looks like a photograph album.
 */
export const TRIBUTE_THEME = {
  /** Deep warm grey-brown. Reads as "quiet" on a projector, not as "off". */
  background: '#1c1815',
  /** Soft warm off-white — never pure #fff, which glares. */
  foreground: '#f4efe7',
  muted: '#c8bcab',
  accent: '#b8926a',
  serif:
    "'Iowan Old Style', 'Palatino Linotype', 'Book Antiqua', Palatino, Georgia, 'Times New Roman', serif",
  sans: "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
} as const;

export type TributeTheme = typeof TRIBUTE_THEME;
