/**
 * When each slide is on screen, decided by arithmetic.
 *
 * Everything in this file is a pure function of its arguments. That is not
 * fastidiousness: the same numbers have to come out in the browser preview and
 * in the renderer, on two different machines, months apart, or the family
 * watches one video and the funeral home plays another. No clock, no random,
 * no database, no I/O.
 *
 * The rules it encodes come from the research rather than from taste:
 *  - photographs hold for 3–7 seconds; below three the room cannot land on a
 *    face, above seven it starts to feel like a screensaver
 *  - cards (title, quote, closing) have fixed, slightly longer holds, because
 *    people are reading them
 *  - a crossfade overlaps its neighbours, so the wall-clock length of a
 *    slideshow is always less than the sum of its slides
 *  - when there is music with a known beat grid, slide changes land on phrase
 *    boundaries, and phrases beat bars — but only if the move is small enough
 *    that nobody notices the slide was nudged
 */
import type {
  BeatGrid,
  CutName,
  Edl,
  ResolvedChapter,
  ResolvedSlide,
  ResolvedTimeline,
  Slide,
  Transition,
} from '@col/schemas';

/* -------------------------------------------------------------------------- */
/* the bands                                                                   */
/* -------------------------------------------------------------------------- */

/** The researched comfortable band for a full-screen photograph. */
export const PHOTO_MIN_SEC = 3;
export const PHOTO_MAX_SEC = 7;
/** Where a photo starts before anything is fitted to a target. */
export const PHOTO_DEFAULT_SEC = 4.5;

export const TITLE_SEC = 4;
export const QUOTE_SEC = 6;
export const CLOSING_SEC = 6;

/** Long enough to read as a dissolve, short enough not to smear two faces. */
export const CROSSFADE_SEC = 0.8;

/** How far a boundary may be moved to land on the music. */
export const SNAP_TOLERANCE_SEC = 0.75;

/** Wolfelt-adjacent convention: the service cut is about five minutes. */
export const SERVICE_TARGET_SEC = 300;

/** Fixed holds, by slide kind. Photos are the only elastic thing here. */
export const FIXED_DURATIONS: Record<Exclude<Slide['kind'], 'photo'>, number> = {
  title: TITLE_SEC,
  quote: QUOTE_SEC,
  closing: CLOSING_SEC,
};

export type SlideKind = Slide['kind'];

/** The minimum the timing engine will ever give a slide of this kind. */
export function minDurationFor(kind: SlideKind): number {
  return kind === 'photo' ? PHOTO_MIN_SEC : FIXED_DURATIONS[kind];
}

export function maxDurationFor(kind: SlideKind): number {
  return kind === 'photo' ? PHOTO_MAX_SEC : FIXED_DURATIONS[kind];
}

/** Clamp a requested hold into the band its kind allows. */
export function clampDuration(kind: SlideKind, seconds: number | undefined): number {
  if (kind !== 'photo') return FIXED_DURATIONS[kind];
  const wanted = seconds == null || !Number.isFinite(seconds) ? PHOTO_DEFAULT_SEC : seconds;
  return Math.min(PHOTO_MAX_SEC, Math.max(PHOTO_MIN_SEC, wanted));
}

/* -------------------------------------------------------------------------- */
/* inputs                                                                      */
/* -------------------------------------------------------------------------- */

export type TimingSlide = {
  id: string;
  kind: SlideKind;
  /** The hold the EDL asked for. Clamped into the band; absent means default. */
  durationSec?: number;
  /** How this slide leaves. A crossfade is what makes the overlap. */
  transitionOut?: Transition;
  chapterId?: string;
};

export type AssignTimingsOptions = {
  /** Wall-clock length to aim for. Omitted means "leave the holds alone". */
  targetSec?: number;
  /** Snap boundaries to this track's phrases when one is supplied. */
  beatGrid?: BeatGrid;
  /** Boundaries are quantised to whole frames so preview and render agree. */
  fps?: number;
  /** How far a boundary may travel to reach a phrase. */
  snapToleranceSec?: number;
};

export type Timing = {
  slides: ResolvedSlide[];
  /** Wall-clock length, transition overlap already subtracted. */
  totalSec: number;
  fps: number;
};

export const DEFAULT_FPS = 30;

/* -------------------------------------------------------------------------- */
/* overlap                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * How much of slide i+1 happens while slide i is still on screen.
 *
 * A dissolve cannot be longer than half of either slide it joins, or the two
 * pictures never exist alone and the effect reads as a smear rather than a
 * transition.
 */
export function overlapFor(
  transition: Transition | undefined,
  currentSec: number,
  nextSec: number,
): number {
  if (!transition || transition.kind === 'cut') return 0;
  return Math.max(0, Math.min(transition.durationSec, currentSec / 2, nextSec / 2));
}

function overlapsFor(slides: readonly TimingSlide[], durations: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < slides.length - 1; i += 1) {
    out.push(overlapFor(slides[i]?.transitionOut, durations[i] ?? 0, durations[i + 1] ?? 0));
  }
  return out;
}

/** Wall-clock length of a run of slides with these durations. */
export function totalWithOverlap(
  slides: readonly TimingSlide[],
  durations: readonly number[],
): number {
  const sum = durations.reduce((a, b) => a + b, 0);
  const overlap = overlapsFor(slides, durations).reduce((a, b) => a + b, 0);
  return Math.max(0, sum - overlap);
}

/* -------------------------------------------------------------------------- */
/* fitting to a target                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Stretch or squeeze the photographs — and only the photographs — until the
 * whole thing is about `wantedSum` seconds of held frames.
 *
 * Classic water-filling: scale everything by one factor, freeze whatever hits
 * the edge of the band, redistribute what is left over the rest, repeat. Cards
 * are never scaled, because a quote card that flashes past in two seconds is
 * worse than a slideshow that runs eleven seconds long.
 */
export function scalePhotoDurations(
  slides: readonly TimingSlide[],
  base: readonly number[],
  wantedSum: number,
): number[] {
  const out = [...base];
  const photoIdx = slides.map((s, i) => (s.kind === 'photo' ? i : -1)).filter((i) => i >= 0);
  if (photoIdx.length === 0) return out;

  const fixedSum = slides.reduce((sum, s, i) => (s.kind === 'photo' ? sum : sum + (base[i] ?? 0)), 0);
  let remaining = wantedSum - fixedSum;
  let free = photoIdx;

  // Bounded: every pass either freezes at least one slide or finishes.
  for (let pass = 0; pass <= photoIdx.length; pass += 1) {
    const freeBase = free.reduce((sum, i) => sum + (base[i] ?? 0), 0);
    if (free.length === 0 || freeBase <= 0) break;

    const factor = remaining / freeBase;
    const stillFree: number[] = [];
    let froze = false;

    for (const i of free) {
      const wanted = (base[i] ?? 0) * factor;
      if (wanted < PHOTO_MIN_SEC) {
        out[i] = PHOTO_MIN_SEC;
        remaining -= PHOTO_MIN_SEC;
        froze = true;
      } else if (wanted > PHOTO_MAX_SEC) {
        out[i] = PHOTO_MAX_SEC;
        remaining -= PHOTO_MAX_SEC;
        froze = true;
      } else {
        stillFree.push(i);
      }
    }

    if (!froze) {
      for (const i of stillFree) out[i] = (base[i] ?? 0) * factor;
      return out;
    }
    free = stillFree;
  }

  // Everything hit a rail. Whatever is left keeps the rail it hit.
  for (const i of free) out[i] = clampDuration('photo', base[i]);
  return out;
}

/* -------------------------------------------------------------------------- */
/* beat snapping                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The nearest musical moment to `seconds`, phrases first.
 *
 * Phrases beat beats: a slide change on the downbeat of a new phrase reads as
 * intentional, one on an arbitrary beat reads as coincidence. Beats are the
 * fallback so that a track with sparse phrase marks still gets something.
 */
export function snapBoundary(
  grid: BeatGrid | undefined,
  seconds: number,
  toleranceSec = SNAP_TOLERANCE_SEC,
): number | undefined {
  if (!grid) return undefined;
  const phrase = nearest(grid.phrases, seconds, toleranceSec);
  if (phrase !== undefined) return phrase;
  return nearest(grid.beats, seconds, toleranceSec);
}

function nearest(
  points: readonly number[],
  seconds: number,
  toleranceSec: number,
): number | undefined {
  let best: number | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const point of points) {
    const distance = Math.abs(point - seconds);
    // `<` rather than `<=` so an exact tie keeps the earlier point: ties must
    // resolve the same way on every machine.
    if (distance <= toleranceSec && distance < bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return best;
}

/* -------------------------------------------------------------------------- */
/* the engine                                                                  */
/* -------------------------------------------------------------------------- */

function quantise(seconds: number, fps: number): number {
  return Math.max(1, Math.round(seconds * fps)) / fps;
}

/**
 * Lay a run of slides out on the clock.
 *
 * Order of operations matters and is fixed: clamp into the band → fit to the
 * target → snap to the music → quantise to frames. Snapping after fitting means
 * a snap can cost the target half a second, which is the right trade: nobody
 * measures a slideshow with a stopwatch, and everybody hears a slide change
 * land off the phrase.
 */
export function assignTimings(
  slides: readonly TimingSlide[],
  options: AssignTimingsOptions = {},
): Timing {
  const fps = options.fps ?? DEFAULT_FPS;
  if (slides.length === 0) return { slides: [], totalSec: 0, fps };

  const tolerance = options.snapToleranceSec ?? SNAP_TOLERANCE_SEC;
  let durations = slides.map((slide) => clampDuration(slide.kind, slide.durationSec));

  if (options.targetSec != null && options.targetSec > 0) {
    // Overlap depends on the durations we are solving for, so solve twice: the
    // second pass sees the overlap the first pass produced. It converges
    // immediately in every realistic case (overlaps only move when a slide is
    // pinned to the bottom of the band).
    for (let pass = 0; pass < 3; pass += 1) {
      const overlap = overlapsFor(slides, durations).reduce((a, b) => a + b, 0);
      const next = scalePhotoDurations(slides, durations, options.targetSec + overlap);
      const settled = next.every((d, i) => Math.abs(d - (durations[i] ?? 0)) < 1e-6);
      durations = next;
      if (settled) break;
    }
  }

  const out: ResolvedSlide[] = [];
  let cursor = 0;

  for (let i = 0; i < slides.length; i += 1) {
    const slide = slides[i];
    if (!slide) continue;
    let duration = durations[i] ?? clampDuration(slide.kind, undefined);

    if (options.beatGrid && i < slides.length - 1) {
      const overlap = overlapFor(slide.transitionOut, duration, durations[i + 1] ?? duration);
      // The boundary a viewer perceives is the moment the next picture starts
      // to arrive, not the moment this one finally disappears.
      const boundary = cursor + duration - overlap;
      const snapped = snapBoundary(options.beatGrid, boundary, tolerance);
      if (snapped !== undefined) {
        const candidate = snapped - cursor + overlap;
        if (withinBand(slide.kind, candidate, tolerance)) duration = candidate;
      }
    }

    duration = quantise(duration, fps);
    out.push({
      slideId: slide.id,
      startSec: Math.round(cursor * fps) / fps,
      durationSec: duration,
      ...(slide.chapterId === undefined ? {} : { chapterId: slide.chapterId }),
    });

    const overlap = quantise0(
      overlapFor(slide.transitionOut, duration, durations[i + 1] ?? duration),
      fps,
    );
    cursor += duration - overlap;
  }

  const last = out[out.length - 1];
  const totalSec = last ? Math.round((last.startSec + last.durationSec) * fps) / fps : 0;
  return { slides: out, totalSec, fps };
}

/** Like quantise, but zero is a legitimate answer (a cut has no overlap). */
function quantise0(seconds: number, fps: number): number {
  return Math.max(0, Math.round(seconds * fps)) / fps;
}

/**
 * Cards may be nudged by the snap tolerance and no further; photographs must
 * stay inside their band even when the music would prefer otherwise. A photo
 * held for nine seconds to catch a phrase is a photo the room has finished
 * looking at.
 */
export function withinBand(kind: SlideKind, seconds: number, tolerance = SNAP_TOLERANCE_SEC): boolean {
  if (kind === 'photo') return seconds >= PHOTO_MIN_SEC && seconds <= PHOTO_MAX_SEC;
  const fixed = FIXED_DURATIONS[kind];
  return seconds >= fixed - tolerance && seconds <= fixed + tolerance;
}

/* -------------------------------------------------------------------------- */
/* cut projection                                                              */
/* -------------------------------------------------------------------------- */

/** Slides in the order the chapters put them, omissions already skipped. */
export function orderedSlides(edl: Edl): TimingSlide[] {
  const omitted = new Set(edl.omittedSlideIds);
  const out: TimingSlide[] = [];
  for (const chapter of edl.chapters) {
    for (const slideId of chapter.slideIds) {
      if (omitted.has(slideId)) continue;
      const slide = edl.slides[slideId];
      if (!slide) continue;
      out.push({
        id: slideId,
        kind: slide.kind,
        durationSec: slide.durationSec,
        ...(slide.kind === 'closing' ? {} : { transitionOut: slide.transitionOut }),
        chapterId: chapter.id,
      });
    }
  }
  return out;
}

/** Missing analysis is neither a recommendation nor a condemnation. */
export const DEFAULT_SUITABILITY = 0.5;

export function suitabilityOf(edl: Edl, slideId: string): number {
  const slide = edl.slides[slideId];
  if (!slide || slide.kind !== 'photo') return 1;
  return slide.suitability ?? DEFAULT_SUITABILITY;
}

/**
 * The shortest this run of slides could possibly be, every photo pinned to the
 * bottom of its band. If that is still longer than the service target, the only
 * way down is to drop a photograph.
 */
export function floorDuration(slides: readonly TimingSlide[]): number {
  const durations = slides.map((s) => minDurationFor(s.kind));
  return totalWithOverlap(slides, durations);
}

export type CutProjectionOptions = {
  fps?: number;
  beatGrid?: BeatGrid;
  /** Override the target the EDL carries. */
  targetSec?: number;
};

/**
 * One slide set, two lengths.
 *
 * The service cut is a *projection* of the family cut rather than a second
 * edit: it drops the weakest photographs until five minutes is achievable, and
 * never touches the title, the quote cards or the closing. Two rules keep it
 * from lying about the life — every chapter keeps at least one photograph, so
 * no part of a life silently disappears, and the drops are the lowest
 * `slideSuitability` first, so what goes is what would not have read from the
 * back of the room anyway.
 */
export function projectCut(
  edl: Edl,
  cut: CutName,
  options: CutProjectionOptions = {},
): ResolvedTimeline {
  const fps = options.fps ?? edl.fps ?? DEFAULT_FPS;
  const all = orderedSlides(edl);
  const beatGrid = options.beatGrid ?? edl.audio.beatGrid;

  const kept = cut === 'service' ? serviceSelection(edl, all, options) : all;
  const keptIds = new Set(kept.map((s) => s.id));
  const droppedSlideIds = all.filter((s) => !keptIds.has(s.id)).map((s) => s.id);

  const targetSec =
    options.targetSec ??
    (cut === 'service' ? (edl.cuts.service.targetSec ?? SERVICE_TARGET_SEC) : edl.cuts.family?.targetSec);

  const timing = assignTimings(kept, {
    fps,
    ...(beatGrid ? { beatGrid } : {}),
    ...(targetSec == null ? {} : { targetSec }),
  });

  return {
    cut,
    fps,
    totalSec: timing.totalSec,
    slides: timing.slides,
    chapters: chapterMarkers(edl, timing.slides),
    droppedSlideIds,
  };
}

/**
 * Which slides survive the service cut.
 *
 * An explicit `includeSlideIds` on the EDL is the family's own answer and wins
 * outright; otherwise we drop, one photograph at a time, until the target is
 * reachable.
 */
function serviceSelection(
  edl: Edl,
  all: readonly TimingSlide[],
  options: CutProjectionOptions,
): TimingSlide[] {
  const explicit = edl.cuts.service.includeSlideIds;
  if (explicit && explicit.length > 0) {
    const wanted = new Set(explicit);
    return all.filter((slide) => wanted.has(slide.id));
  }

  const target = options.targetSec ?? edl.cuts.service.targetSec ?? SERVICE_TARGET_SEC;
  let kept = [...all];

  // Bounded by the number of photographs: each pass removes exactly one.
  for (let pass = 0; pass < all.length; pass += 1) {
    if (floorDuration(kept) <= target) break;
    const victim = weakestDroppable(edl, kept);
    if (!victim) break;
    kept = kept.filter((slide) => slide.id !== victim);
  }
  return kept;
}

/**
 * The photograph we would miss least, or nothing at all if every chapter is
 * down to its last one. Ties break on slide id so two runs never disagree.
 */
function weakestDroppable(edl: Edl, kept: readonly TimingSlide[]): string | undefined {
  const photosPerChapter = new Map<string, number>();
  for (const slide of kept) {
    if (slide.kind !== 'photo') continue;
    const key = slide.chapterId ?? '';
    photosPerChapter.set(key, (photosPerChapter.get(key) ?? 0) + 1);
  }

  let best: { id: string; suitability: number } | undefined;
  for (const slide of kept) {
    if (slide.kind !== 'photo') continue;
    if ((photosPerChapter.get(slide.chapterId ?? '') ?? 0) <= 1) continue;
    const suitability = suitabilityOf(edl, slide.id);
    if (
      !best ||
      suitability < best.suitability ||
      (suitability === best.suitability && slide.id < best.id)
    ) {
      best = { id: slide.id, suitability };
    }
  }
  return best?.id;
}

function chapterMarkers(edl: Edl, resolved: readonly ResolvedSlide[]): ResolvedChapter[] {
  const out: ResolvedChapter[] = [];
  for (const chapter of edl.chapters) {
    const mine = resolved.filter((slide) => slide.chapterId === chapter.id);
    const first = mine[0];
    if (!first) continue;
    out.push({
      id: chapter.id,
      title: chapter.title,
      startSec: first.startSec,
      slideCount: mine.length,
    });
  }
  return out;
}

/**
 * Bake the family cut's holds back onto the slides.
 *
 * Without this the stored durations are the engine's starting guesses and the
 * fitted ones only exist at play time, which means "make this one a bit longer"
 * would be a nudge to a number nobody is using. Running the fit once at
 * assembly and writing the answers down makes every later edit an edit to the
 * thing the family is actually watching.
 */
export function withFittedDurations(edl: Edl): Edl {
  const timeline = projectCut(edl, 'family');
  const durations = new Map(timeline.slides.map((slide) => [slide.slideId, slide.durationSec]));
  const slides: Edl['slides'] = {};
  for (const [slideId, slide] of Object.entries(edl.slides)) {
    const fitted = durations.get(slideId);
    slides[slideId] = fitted == null ? slide : { ...slide, durationSec: fitted };
  }
  return { ...edl, slides };
}

/** Frames a cut occupies. What Remotion's `durationInFrames` is set from. */
export function durationInFrames(timeline: ResolvedTimeline): number {
  return Math.max(1, Math.round(timeline.totalSec * timeline.fps));
}

/** "About five minutes" — the only length language a family should have to read. */
export function describeLength(totalSec: number): string {
  const rounded = Math.round(totalSec);
  const minutes = Math.floor(rounded / 60);
  const seconds = rounded % 60;
  if (minutes === 0) return `${seconds} seconds`;
  if (seconds === 0) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  return `${minutes} min ${seconds < 10 ? '0' : ''}${seconds} sec`;
}
