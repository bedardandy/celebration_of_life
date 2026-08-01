/**
 * Turning a proposal into an edit decision list.
 *
 * One model call decides ordering, grouping and the few words on the cards.
 * Everything after that is arithmetic in this file: hints become rectangles,
 * the timing engine assigns holds, and the two cuts fall out of the same slide
 * set. If the model returns something impossible — an asset id that does not
 * exist, a "quote" it rewrote — the assembly drops it and says so, rather than
 * failing the whole job or, worse, putting invented words on a screen at a
 * funeral.
 */
import {
  EDL_VERSION,
  EdlProposalSchema,
  EdlSchema,
  type AssetVariantKind,
  type AudioMode,
  type Easing,
  type Edl,
  type EdlChapter,
  type EdlProposal,
  type KenBurns,
  type KenBurnsHint,
  type Rect,
  type Slide,
} from '@col/schemas';
import {
  EDL_SYSTEM_PROMPT,
  EDL_TASK,
  buildEdlPrompt,
  generateObject,
  resolveProvider,
  type AiProvider,
  type EdlPromptAsset,
  type EdlPromptQuote,
} from '@col/ai';
import {
  CROSSFADE_SEC,
  DEFAULT_FPS,
  PHOTO_DEFAULT_SEC,
  SERVICE_TARGET_SEC,
  clampDuration,
  withFittedDurations,
} from './timing';

/* -------------------------------------------------------------------------- */
/* hint → rectangle                                                            */
/* -------------------------------------------------------------------------- */

const wide = (x: number, y: number, w: number): Rect => ({ x, y, w, h: w });

/**
 * The whole vocabulary of camera movement in this product, four entries long.
 *
 * A Ken Burns move on a memorial photograph should be almost invisible: enough
 * that the picture is not a static rectangle for five seconds, never enough
 * that anyone notices it moving. So every move here is a slow push of about
 * eight percent, biased toward wherever the face is, and `wide` barely moves at
 * all — a landscape or a group photograph loses more from being cropped in than
 * it gains from the motion.
 *
 * Rectangles are the visible window on the source image, in 0..1 space. The
 * composition scales by 1/w and centres on the rectangle's middle, so `h` only
 * ever affects the vertical centre — that is what keeps a photograph from being
 * stretched to fit a frame it was never shaped for.
 */
export const KEN_BURNS_RECTS: Record<KenBurnsHint, { from: Rect; to: Rect; easing: Easing }> = {
  center: { from: wide(0.0, 0.0, 1.0), to: wide(0.05, 0.04, 0.9), easing: 'easeInOut' },
  'face-left': { from: wide(0.0, 0.0, 1.0), to: wide(0.02, 0.04, 0.82), easing: 'easeInOut' },
  'face-right': { from: wide(0.0, 0.0, 1.0), to: wide(0.16, 0.04, 0.82), easing: 'easeInOut' },
  wide: { from: wide(0.02, 0.02, 0.96), to: wide(0.0, 0.0, 1.0), easing: 'easeInOut' },
};

export function kenBurnsFor(hint: KenBurnsHint): KenBurns {
  const entry = KEN_BURNS_RECTS[hint] ?? KEN_BURNS_RECTS.center;
  return { from: { ...entry.from }, to: { ...entry.to }, easing: entry.easing };
}

/* -------------------------------------------------------------------------- */
/* assembly input                                                              */
/* -------------------------------------------------------------------------- */

export type EdlAssetInput = {
  assetId: string;
  /** The family's caption wins over anything the model suggests. */
  caption?: string | null;
  suitability?: number | null;
  eraGuess?: string | null;
  description?: string | null;
  emotionalTone?: string | null;
  settingTags?: readonly string[];
  suggestedCaption?: string | null;
  width?: number | null;
  height?: number | null;
  /**
   * Which derivative this photograph should be shown from. Set to
   * 'enhanced2400' only when the family looked at a before-and-after and said
   * they preferred the improved copy; everything else stays on the plain one.
   */
  variant?: AssetVariantKind;
};

export type EdlQuoteInput = {
  text: string;
  attribution: string;
};

export type EdlBuildContext = {
  projectId: string;
  subject: { fullName: string; knownAs?: string; birthYear?: number; deathYear?: number };
  assets: readonly EdlAssetInput[];
  /** Approved anecdotes and memory notes. The only text a quote card may use. */
  quotes: readonly EdlQuoteInput[];
  structure: 'chrono' | 'thematic' | 'mixed';
  /** The family cut's length. The service cut is projected from it. */
  targetSec?: number;
  serviceTargetSec?: number;
  themeId?: string;
  audioMode?: AudioMode;
  fps?: number;
  resolution?: { w: number; h: number };
  storyChapters?: readonly { title: string; summary?: string }[];
  themes?: readonly string[];
  toneNotes?: string;
  traditionNotes?: string;
};

export type AssembleResult = {
  edl: Edl;
  /** Everything quietly discarded, in words a log reader can act on. */
  warnings: string[];
};

export const DEFAULT_FAMILY_TARGET_SEC = 420;
export const DEFAULT_RESOLUTION = { w: 1920, h: 1080 } as const;
export const DEFAULT_THEME_ID = 'quiet-linen';

/** Which derivative the renderer reads. Originals never enter a composition. */
export const SLIDE_VARIANT = 'render2400' as const;

/* -------------------------------------------------------------------------- */
/* verbatim checking                                                           */
/* -------------------------------------------------------------------------- */

/** Whitespace and case are noise; every other difference is a rewrite. */
export function normalizeQuote(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The approved memory this quote is a copy of, if it is a copy of one.
 *
 * Deliberately unforgiving. "Close enough" is how a sentence someone's son
 * wrote turns into a sentence a language model preferred, on a screen, at a
 * funeral, with no way to tell afterwards which one it was.
 */
export function matchApprovedQuote(
  text: string,
  quotes: readonly EdlQuoteInput[],
): EdlQuoteInput | undefined {
  const wanted = normalizeQuote(text);
  return quotes.find((quote) => normalizeQuote(quote.text) === wanted);
}

/* -------------------------------------------------------------------------- */
/* assembly                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Proposal in, EDL out, with every number decided here.
 *
 * Ids are positional and stable (`c1`, `c1-s2`) so the same proposal assembles
 * to the same EDL byte for byte — which is what makes the whole pipeline
 * testable and a regenerate diffable.
 */
export function assembleEdl(proposal: EdlProposal, context: EdlBuildContext): AssembleResult {
  const warnings: string[] = [];
  const byId = new Map(context.assets.map((asset) => [asset.assetId, asset]));
  const used = new Set<string>();

  const slides: Record<string, Slide> = {};
  const chapters: EdlChapter[] = [];
  const fps = context.fps ?? DEFAULT_FPS;

  const titleId = 'opening-title';
  slides[titleId] = {
    kind: 'title',
    text: proposal.openingTitle.text.trim() || context.subject.fullName,
    ...(proposal.openingTitle.subtext?.trim()
      ? { subtext: proposal.openingTitle.subtext.trim() }
      : {}),
    durationSec: clampDuration('title', undefined),
    transitionOut: { kind: 'crossfade', durationSec: CROSSFADE_SEC },
  };
  chapters.push({ id: 'opening', title: 'Opening', slideIds: [titleId] });

  proposal.chapters.forEach((chapter, chapterIndex) => {
    const chapterId = `c${chapterIndex + 1}`;
    const before: string[] = [];
    const middle: string[] = [];
    const after: string[] = [];
    let counter = 0;

    for (const quote of chapter.quotes) {
      const approved = matchApprovedQuote(quote.text, context.quotes);
      if (!approved) {
        warnings.push(
          `dropped a quote card in "${chapter.title}": the text is not a word-for-word copy of an approved memory`,
        );
        continue;
      }
      counter += 1;
      const slideId = `${chapterId}-q${counter}`;
      slides[slideId] = {
        kind: 'quote',
        text: approved.text.trim(),
        attribution: approved.attribution.trim(),
        durationSec: clampDuration('quote', undefined),
        transitionOut: { kind: 'fadeThroughBlack', durationSec: CROSSFADE_SEC },
      };
      (quote.placement === 'after' ? after : before).push(slideId);
    }

    for (const photo of chapter.photos) {
      const asset = byId.get(photo.assetId);
      if (!asset) {
        warnings.push(`dropped slide for unknown asset id "${photo.assetId}"`);
        continue;
      }
      if (used.has(photo.assetId)) {
        warnings.push(`dropped a repeat of asset "${photo.assetId}"`);
        continue;
      }
      used.add(photo.assetId);
      counter += 1;
      const slideId = `${chapterId}-s${counter}`;
      const caption = (asset.caption ?? photo.caption ?? asset.suggestedCaption ?? '').trim();
      slides[slideId] = {
        kind: 'photo',
        assetId: asset.assetId,
        variant: asset.variant ?? SLIDE_VARIANT,
        durationSec: PHOTO_DEFAULT_SEC,
        kenBurns: kenBurnsFor(photo.kenBurns),
        ...(caption ? { caption: { text: caption.slice(0, 300), position: 'lower-third' } } : {}),
        transitionOut: { kind: 'crossfade', durationSec: CROSSFADE_SEC },
        ...(asset.suitability == null ? {} : { suitability: clamp01(asset.suitability) }),
        ...(aspectOf(asset) == null ? {} : { sourceAspect: aspectOf(asset) as number }),
      };
      middle.push(slideId);
    }

    const slideIds = [...before, ...middle, ...after];
    if (slideIds.length === 0) {
      warnings.push(`dropped empty chapter "${chapter.title}"`);
      return;
    }
    chapters.push({ id: chapterId, title: chapter.title.trim().slice(0, 120), slideIds });
  });

  const unusedIds = context.assets.filter((asset) => !used.has(asset.assetId));
  if (unusedIds.length > 0) {
    warnings.push(
      `${unusedIds.length} approved ${unusedIds.length === 1 ? 'photo was' : 'photos were'} not placed in any chapter`,
    );
  }

  const closingId = 'closing-card';
  slides[closingId] = {
    kind: 'closing',
    line1: proposal.closing.line1.trim() || context.subject.fullName,
    line2: proposal.closing.line2.trim(),
    durationSec: clampDuration('closing', undefined),
  };
  chapters.push({ id: 'closing', title: 'Closing', slideIds: [closingId] });

  const edl: Edl = {
    version: EDL_VERSION,
    projectId: context.projectId,
    fps,
    resolution: context.resolution ?? { ...DEFAULT_RESOLUTION },
    audio: { mode: context.audioMode ?? 'sideloaded', startOffsetSec: 0 },
    theme: { id: context.themeId ?? DEFAULT_THEME_ID },
    chapters,
    slides,
    cuts: {
      service: { targetSec: context.serviceTargetSec ?? SERVICE_TARGET_SEC },
      family: { targetSec: context.targetSec ?? DEFAULT_FAMILY_TARGET_SEC },
    },
    omittedSlideIds: [],
  };

  // Parse rather than trust: assembly is the last place a malformed EDL can be
  // caught before it reaches a database, a renderer and a room full of people.
  return { edl: withFittedDurations(EdlSchema.parse(edl)), warnings };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function aspectOf(asset: EdlAssetInput): number | undefined {
  if (!asset.width || !asset.height || asset.height <= 0) return undefined;
  return Number((asset.width / asset.height).toFixed(4));
}

/* -------------------------------------------------------------------------- */
/* the call                                                                    */
/* -------------------------------------------------------------------------- */

export type GenerateEdlResult = AssembleResult & {
  proposal: EdlProposal;
  providerId: string;
  attempts: number;
};

export function promptAssetsFor(assets: readonly EdlAssetInput[]): EdlPromptAsset[] {
  return assets.map((asset) => ({
    assetId: asset.assetId,
    ...(asset.eraGuess ? { eraGuess: asset.eraGuess } : {}),
    ...(asset.description ? { description: asset.description } : {}),
    ...(asset.emotionalTone ? { emotionalTone: asset.emotionalTone } : {}),
    ...(asset.settingTags && asset.settingTags.length > 0
      ? { settingTags: asset.settingTags }
      : {}),
    ...(asset.suitability == null ? {} : { suitability: asset.suitability }),
    ...(asset.suggestedCaption ? { suggestedCaption: asset.suggestedCaption } : {}),
  }));
}

export function promptQuotesFor(quotes: readonly EdlQuoteInput[]): EdlPromptQuote[] {
  return quotes.map((quote) => ({ text: quote.text, attribution: quote.attribution }));
}

/**
 * One call, then arithmetic.
 *
 * The provider is resolved by task, so a family can drive this from a Claude
 * subscription, a local model or the deterministic mock without a line of this
 * file changing.
 */
export async function generateEdl(
  context: EdlBuildContext,
  options: { provider?: AiProvider } = {},
): Promise<GenerateEdlResult> {
  const provider = options.provider ?? resolveProvider('edl-generation');
  const prompt = buildEdlPrompt({
    subject: context.subject,
    assets: promptAssetsFor(context.assets),
    quotes: promptQuotesFor(context.quotes),
    structure: context.structure,
    targetSec: context.targetSec ?? DEFAULT_FAMILY_TARGET_SEC,
    ...(context.storyChapters ? { storyChapters: context.storyChapters } : {}),
    ...(context.themes ? { themes: context.themes } : {}),
    ...(context.toneNotes ? { toneNotes: context.toneNotes } : {}),
    ...(context.traditionNotes ? { traditionNotes: context.traditionNotes } : {}),
  });

  const result = await generateObject(provider, EdlProposalSchema, {
    taskTag: EDL_TASK,
    messages: [
      { role: 'system', content: EDL_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
  });

  const assembled = assembleEdl(result.object, context);
  return {
    ...assembled,
    proposal: result.object,
    providerId: provider.id,
    attempts: result.attempts,
  };
}

/**
 * A slideshow when there is no model at hand: every approved photograph, in the
 * order the family already sees them, in one chapter.
 *
 * Not a fallback for a failed call — the job surfaces those — but the honest
 * shape of "we have photographs and nothing else", which is where a family with
 * no AI consent and no interview still deserves to end up with a video.
 */
export function plainProposal(context: EdlBuildContext): EdlProposal {
  const years =
    context.subject.birthYear && context.subject.deathYear
      ? `${context.subject.birthYear} — ${context.subject.deathYear}`
      : '';
  return EdlProposalSchema.parse({
    openingTitle: {
      text: context.subject.fullName,
      ...(years ? { subtext: years } : {}),
    },
    chapters: [
      {
        title: 'Their life',
        photos: context.assets.map((asset) => ({
          assetId: asset.assetId,
          kenBurns: 'center',
        })),
        quotes: [],
      },
    ],
    closing: { line1: context.subject.fullName, line2: years },
  });
}
