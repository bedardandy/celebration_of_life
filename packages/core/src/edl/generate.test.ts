/**
 * The seam between "a model suggested this" and "a family will watch this".
 *
 * Everything here is about what assembly refuses: an asset id nobody uploaded,
 * a quote card carrying words that were tidied up on the way through, a
 * duration the model tried to set. Those are the failures that would be
 * discovered in a room full of people, so they are caught in a test instead.
 */
import { describe, expect, it } from 'vitest';
import { EdlSchema, type EdlProposal } from '@col/schemas';
import { resetMockState } from '@col/ai';
import {
  KEN_BURNS_RECTS,
  assembleEdl,
  generateEdl,
  kenBurnsFor,
  matchApprovedQuote,
  normalizeQuote,
  plainProposal,
  type EdlBuildContext,
} from './generate';
import { PHOTO_MAX_SEC, PHOTO_MIN_SEC, projectCut } from './timing';

const QUOTE = 'She always said the garden would outlive her, and it has.';

function context(overrides: Partial<EdlBuildContext> = {}): EdlBuildContext {
  return {
    projectId: 'project-1',
    subject: { fullName: 'Margaret Anne Doyle', birthYear: 1938, deathYear: 2024 },
    assets: [
      { assetId: 'asset-1', suitability: 0.8, width: 4000, height: 3000 },
      { assetId: 'asset-2', suitability: 0.4, width: 3000, height: 4000 },
      { assetId: 'asset-3', suitability: 0.6, caption: 'The kitchen table, 1974' },
    ],
    quotes: [{ text: QUOTE, attribution: 'Her daughter, Anne' }],
    structure: 'chrono',
    targetSec: 300,
    ...overrides,
  };
}

function proposal(overrides: Partial<EdlProposal> = {}): EdlProposal {
  return {
    openingTitle: { text: 'Margaret Anne Doyle', subtext: '1938 — 2024' },
    chapters: [
      {
        title: 'Where she began',
        photos: [
          { assetId: 'asset-1', kenBurns: 'center' },
          { assetId: 'asset-2', kenBurns: 'face-left', caption: 'On the beach' },
        ],
        quotes: [{ text: QUOTE, attribution: 'Her daughter, Anne', placement: 'before' }],
      },
      {
        title: 'Later on',
        photos: [{ assetId: 'asset-3', kenBurns: 'wide', caption: 'A caption we will not use' }],
        quotes: [],
      },
    ],
    closing: { line1: 'Margaret Anne Doyle', line2: '1938 — 2024' },
    ...overrides,
  };
}

describe('ken burns hints', () => {
  it('turns each hint into rectangles the code chose, not the model', () => {
    for (const hint of ['center', 'face-left', 'face-right', 'wide'] as const) {
      const move = kenBurnsFor(hint);
      expect(move.from).toEqual(KEN_BURNS_RECTS[hint].from);
      expect(move.to).toEqual(KEN_BURNS_RECTS[hint].to);
      expect(move.easing).toBe('easeInOut');
    }
  });

  it('moves gently — nothing zooms more than a fifth', () => {
    for (const hint of ['center', 'face-left', 'face-right', 'wide'] as const) {
      const { from, to } = KEN_BURNS_RECTS[hint];
      expect(Math.abs(from.w - to.w)).toBeLessThanOrEqual(0.2);
      expect(from.x + from.w).toBeLessThanOrEqual(1.0001);
      expect(to.x + to.w).toBeLessThanOrEqual(1.0001);
    }
  });

  it('hands back a fresh object so two slides never share one rectangle', () => {
    const a = kenBurnsFor('center');
    const b = kenBurnsFor('center');
    expect(a).not.toBe(b);
    expect(a.from).not.toBe(b.from);
  });
});

describe('assembly', () => {
  it('produces a valid EDL with an opening and a closing of its own', () => {
    const { edl } = assembleEdl(proposal(), context());
    expect(() => EdlSchema.parse(edl)).not.toThrow();
    expect(edl.chapters.map((c) => c.id)).toEqual(['opening', 'c1', 'c2', 'closing']);
    expect(edl.slides['opening-title']?.kind).toBe('title');
    expect(edl.slides['closing-card']?.kind).toBe('closing');
  });

  it('gives every photograph a hold inside the band', () => {
    const { edl } = assembleEdl(proposal(), context());
    for (const slide of Object.values(edl.slides)) {
      if (slide.kind !== 'photo') continue;
      expect(slide.durationSec).toBeGreaterThanOrEqual(PHOTO_MIN_SEC);
      expect(slide.durationSec).toBeLessThanOrEqual(PHOTO_MAX_SEC);
    }
  });

  it('drops an asset id nobody uploaded, and says so', () => {
    const invented = proposal();
    invented.chapters[0]?.photos.push({ assetId: 'asset-hallucinated', kenBurns: 'center' });
    const { edl, warnings } = assembleEdl(invented, context());

    const referenced = Object.values(edl.slides)
      .filter((slide) => slide.kind === 'photo')
      .map((slide) => (slide.kind === 'photo' ? slide.assetId : ''));
    expect(referenced).not.toContain('asset-hallucinated');
    expect(warnings.some((w) => w.includes('asset-hallucinated'))).toBe(true);
  });

  it('drops a quote card the model rewrote, however slightly', () => {
    const tidied = proposal();
    const chapter = tidied.chapters[0];
    if (chapter) {
      chapter.quotes = [
        {
          text: 'She always said the garden would outlive her — and it did.',
          attribution: 'Her daughter, Anne',
          placement: 'before',
        },
      ];
    }
    const { edl, warnings } = assembleEdl(tidied, context());
    expect(Object.values(edl.slides).some((slide) => slide.kind === 'quote')).toBe(false);
    expect(warnings.some((w) => w.includes('word-for-word'))).toBe(true);
  });

  it('keeps a quote card that is a true copy, and uses the approved wording', () => {
    const loose = proposal();
    const chapter = loose.chapters[0];
    // Same words, different whitespace and curly quotes: still verbatim.
    if (chapter) chapter.quotes = [{ text: `  ${QUOTE.replace(/'/g, '’')}  `, attribution: 'x', placement: 'before' }];
    const { edl } = assembleEdl(loose, context());
    const quote = Object.values(edl.slides).find((slide) => slide.kind === 'quote');
    expect(quote?.kind).toBe('quote');
    if (quote?.kind === 'quote') {
      expect(quote.text).toBe(QUOTE);
      // Attribution comes from the approved memory, never from the model.
      expect(quote.attribution).toBe('Her daughter, Anne');
    }
  });

  it('puts a quote card where the proposal asked for it', () => {
    const withAfter = proposal();
    const chapter = withAfter.chapters[0];
    if (chapter) chapter.quotes = [{ text: QUOTE, attribution: 'Anne', placement: 'after' }];
    const { edl } = assembleEdl(withAfter, context());
    const ids = edl.chapters.find((c) => c.id === 'c1')?.slideIds ?? [];
    expect(edl.slides[ids[ids.length - 1] ?? '']?.kind).toBe('quote');
  });

  it('lets the family caption win over the model one', () => {
    const { edl } = assembleEdl(proposal(), context());
    const slide = Object.values(edl.slides).find(
      (s) => s.kind === 'photo' && s.assetId === 'asset-3',
    );
    if (slide?.kind === 'photo') expect(slide.caption?.text).toBe('The kitchen table, 1974');
  });

  it('carries suitability and shape onto the slide, so a cut can be projected offline', () => {
    const { edl } = assembleEdl(proposal(), context());
    const portrait = Object.values(edl.slides).find(
      (s) => s.kind === 'photo' && s.assetId === 'asset-2',
    );
    if (portrait?.kind === 'photo') {
      expect(portrait.suitability).toBe(0.4);
      expect(portrait.sourceAspect).toBeCloseTo(0.75, 4);
    }
  });

  it('refuses to use the same photograph twice', () => {
    const repeated = proposal();
    repeated.chapters[1]?.photos.push({ assetId: 'asset-1', kenBurns: 'center' });
    const { edl, warnings } = assembleEdl(repeated, context());
    const used = Object.values(edl.slides)
      .filter((slide) => slide.kind === 'photo')
      .map((slide) => (slide.kind === 'photo' ? slide.assetId : ''));
    expect(new Set(used).size).toBe(used.length);
    expect(warnings.some((w) => w.includes('repeat'))).toBe(true);
  });

  it('notices a photograph the model left out entirely', () => {
    const short = proposal();
    short.chapters = [short.chapters[0] as EdlProposal['chapters'][number]];
    const { warnings } = assembleEdl(short, context());
    expect(warnings.some((w) => w.includes('not placed in any chapter'))).toBe(true);
  });

  it('assembles the same EDL twice from the same proposal', () => {
    expect(assembleEdl(proposal(), context())).toEqual(assembleEdl(proposal(), context()));
  });

  it('sets both cuts up, with the service one shorter', () => {
    const { edl } = assembleEdl(proposal(), context({ targetSec: 420, serviceTargetSec: 300 }));
    expect(edl.cuts.service.targetSec).toBe(300);
    expect(edl.cuts.family?.targetSec).toBe(420);
  });

  it('makes something watchable out of photographs alone', () => {
    const bare = context({ quotes: [] });
    const { edl, warnings } = assembleEdl(plainProposal(bare), bare);
    expect(warnings).toEqual([]);
    expect(projectCut(edl, 'family').slides.length).toBe(5);
  });
});

describe('verbatim checking', () => {
  it('forgives whitespace, case and curly quotes and nothing else', () => {
    expect(normalizeQuote('  She  said “hello”  ')).toBe('she said "hello"');
    const quotes = [{ text: QUOTE, attribution: 'Anne' }];
    expect(matchApprovedQuote(QUOTE.toUpperCase(), quotes)).toBeDefined();
    expect(matchApprovedQuote(`${QUOTE} Truly.`, quotes)).toBeUndefined();
    expect(matchApprovedQuote(QUOTE.replace('garden', 'roses'), quotes)).toBeUndefined();
  });
});

describe('generateEdl against the mock provider', () => {
  it('turns one call into a schema-valid EDL that names only real photographs', async () => {
    resetMockState();
    const ctx = context({
      assets: [
        { assetId: 'asset-1', suitability: 0.9, eraGuess: '1950s', description: 'A portrait' },
        { assetId: 'asset-2', suitability: 0.7, eraGuess: '1960s', description: 'At the beach' },
        { assetId: 'asset-3', suitability: 0.5, eraGuess: '1970s', description: 'A wedding' },
        { assetId: 'asset-4', suitability: 0.6, eraGuess: '1980s', description: 'In the garden' },
      ],
    });
    const result = await generateEdl(ctx);

    expect(() => EdlSchema.parse(result.edl)).not.toThrow();
    expect(result.providerId).toBe('mock');

    const known = new Set(ctx.assets.map((asset) => asset.assetId));
    for (const slide of Object.values(result.edl.slides)) {
      if (slide.kind === 'photo') expect(known.has(slide.assetId)).toBe(true);
    }
    expect(result.edl.chapters.length).toBeGreaterThan(2);
  });

  it('only ever quotes a memory the family approved', async () => {
    resetMockState();
    const result = await generateEdl(context());
    const approved = new Set([normalizeQuote(QUOTE)]);
    for (const slide of Object.values(result.edl.slides)) {
      if (slide.kind === 'quote') expect(approved.has(normalizeQuote(slide.text))).toBe(true);
    }
  });

  it('is deterministic — two runs, one slideshow', async () => {
    resetMockState();
    const first = await generateEdl(context());
    resetMockState();
    const second = await generateEdl(context());
    expect(second.edl).toEqual(first.edl);
  });
});
