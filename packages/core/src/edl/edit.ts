/**
 * The edits a family can make to a slideshow, as pure functions.
 *
 * Every one of them takes an EDL and returns a new EDL, validated on the way
 * out. None of them touch a database, so the preview screen, a server action
 * and a test all get identical behaviour, and an edit that would produce an
 * impossible slideshow fails here rather than three screens later.
 *
 * The grief rules show up as constraints rather than as copy: nothing is ever
 * really deleted (removal is an omission, and omissions are reversible), no
 * edit can push a photograph outside the comfortable band, and every operation
 * is a discrete button press rather than a drag.
 */
import { EdlSchema, type Edl, type PhotoSlide, type Slide } from '@col/schemas';
import {
  PHOTO_MAX_SEC,
  PHOTO_MIN_SEC,
  clampDuration,
  orderedSlides,
  withFittedDurations,
} from './timing';

/** One press of "a bit longer" / "a bit shorter". */
export const NUDGE_SEC = 0.5;

export class EdlEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EdlEditError';
  }
}

function requireSlide(edl: Edl, slideId: string): Slide {
  const slide = edl.slides[slideId];
  if (!slide) throw new EdlEditError(`no slide "${slideId}" in this slideshow`);
  return slide;
}

function withSlide(edl: Edl, slideId: string, slide: Slide): Edl {
  return EdlSchema.parse({ ...edl, slides: { ...edl.slides, [slideId]: slide } });
}

/* -------------------------------------------------------------------------- */
/* captions                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Captions autosave, so an empty box means "no caption" rather than an error.
 * Nobody should have to press Save to un-write a word.
 */
export function setCaption(edl: Edl, slideId: string, text: string): Edl {
  const slide = requireSlide(edl, slideId);
  if (slide.kind !== 'photo') throw new EdlEditError('only a photograph can carry a caption');
  const trimmed = text.trim().slice(0, 300);
  const next: PhotoSlide = trimmed
    ? { ...slide, caption: { text: trimmed, position: slide.caption?.position ?? 'lower-third' } }
    : stripCaption(slide);
  return withSlide(edl, slideId, next);
}

function stripCaption(slide: PhotoSlide): PhotoSlide {
  const { caption: _caption, ...rest } = slide;
  return rest;
}

/* -------------------------------------------------------------------------- */
/* length                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * "A bit longer" / "a bit shorter", in half seconds, inside the band.
 *
 * Cards are refused rather than silently ignored: a quote card has a fixed hold
 * because people are reading it, and a screen that offers a button which does
 * nothing is worse than one that does not offer it.
 */
export function nudgeDuration(edl: Edl, slideId: string, deltaSec: number): Edl {
  const slide = requireSlide(edl, slideId);
  if (slide.kind !== 'photo') {
    throw new EdlEditError('cards are held for a fixed time so there is space to read them');
  }
  const wanted = slide.durationSec + deltaSec;
  const next = clampDuration('photo', wanted);
  if (Math.abs(next - slide.durationSec) < 1e-6) return edl;
  return withSlide(edl, slideId, { ...slide, durationSec: next });
}

/** True when the button would do nothing, so the screen can grey it out. */
export function canNudgeSlide(slide: Slide | undefined, deltaSec: number): boolean {
  if (!slide || slide.kind !== 'photo') return false;
  return deltaSec > 0
    ? slide.durationSec < PHOTO_MAX_SEC - 1e-6
    : slide.durationSec > PHOTO_MIN_SEC + 1e-6;
}

export function canNudge(edl: Edl, slideId: string, deltaSec: number): boolean {
  return canNudgeSlide(edl.slides[slideId], deltaSec);
}

/* -------------------------------------------------------------------------- */
/* order                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Move a slide one place earlier or later.
 *
 * The list a family sees is flat, so the move is flat too: positions belong to
 * chapters, and a slide that moves past a chapter boundary joins that chapter.
 * Explaining "you cannot move that up because it is the first of its chapter"
 * to somebody at midnight is not a conversation worth having.
 */
export function moveSlide(edl: Edl, slideId: string, direction: 'up' | 'down'): Edl {
  const flat = orderedSlides(edl).map((slide) => slide.id);
  const at = flat.indexOf(slideId);
  if (at === -1) throw new EdlEditError(`no slide "${slideId}" in this slideshow`);
  const to = direction === 'up' ? at - 1 : at + 1;
  if (to < 0 || to >= flat.length) return edl;

  const swapped = [...flat];
  swapped[at] = flat[to] as string;
  swapped[to] = flat[at] as string;

  // Rebuild each chapter from the swapped sequence, keeping omitted slides
  // exactly where they were so putting one back lands it in its old place.
  const omitted = new Set(edl.omittedSlideIds);
  let cursor = 0;
  const chapters = edl.chapters.map((chapter) => ({
    ...chapter,
    slideIds: chapter.slideIds.map((id) => (omitted.has(id) ? id : (swapped[cursor++] as string))),
  }));
  return EdlSchema.parse({ ...edl, chapters });
}

/* -------------------------------------------------------------------------- */
/* swapping a photograph                                                       */
/* -------------------------------------------------------------------------- */

export type SwapPhotoInput = {
  assetId: string;
  caption?: string | null;
  suitability?: number | null;
  width?: number | null;
  height?: number | null;
};

/**
 * Put a different photograph in this slot.
 *
 * The framing, the hold and the transition stay with the slot rather than with
 * the picture: the family chose a different photograph, not a different edit.
 */
export function swapPhoto(edl: Edl, slideId: string, replacement: SwapPhotoInput): Edl {
  const slide = requireSlide(edl, slideId);
  if (slide.kind !== 'photo') throw new EdlEditError('only a photograph slide can be swapped');
  const caption = (replacement.caption ?? '').trim();
  const aspect =
    replacement.width && replacement.height && replacement.height > 0
      ? Number((replacement.width / replacement.height).toFixed(4))
      : undefined;

  const { caption: _caption, suitability: _suitability, sourceAspect: _aspect, ...rest } = slide;
  const next: PhotoSlide = {
    ...rest,
    assetId: replacement.assetId,
    ...(caption ? { caption: { text: caption.slice(0, 300), position: 'lower-third' } } : {}),
    ...(replacement.suitability == null
      ? {}
      : { suitability: Math.min(1, Math.max(0, replacement.suitability)) }),
    ...(aspect === undefined ? {} : { sourceAspect: aspect }),
  };
  return withSlide(edl, slideId, next);
}

/* -------------------------------------------------------------------------- */
/* removing, and putting back                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Take a slide out. It stays in the file, in its chapter, at its position.
 *
 * That is the whole trick behind an undo that is exact rather than approximate,
 * and it is why the button says "Remove" and the toast says "Put it back".
 */
export function removeSlide(edl: Edl, slideId: string): Edl {
  requireSlide(edl, slideId);
  if (edl.omittedSlideIds.includes(slideId)) return edl;
  return EdlSchema.parse({ ...edl, omittedSlideIds: [...edl.omittedSlideIds, slideId] });
}

export function restoreSlide(edl: Edl, slideId: string): Edl {
  if (!edl.omittedSlideIds.includes(slideId)) return edl;
  return EdlSchema.parse({
    ...edl,
    omittedSlideIds: edl.omittedSlideIds.filter((id) => id !== slideId),
  });
}

/* -------------------------------------------------------------------------- */
/* applying an edit                                                            */
/* -------------------------------------------------------------------------- */

export type EdlEdit =
  | { op: 'caption'; slideId: string; text: string }
  | { op: 'longer'; slideId: string }
  | { op: 'shorter'; slideId: string }
  | { op: 'move-up'; slideId: string }
  | { op: 'move-down'; slideId: string }
  | { op: 'swap'; slideId: string; replacement: SwapPhotoInput }
  | { op: 'remove'; slideId: string }
  | { op: 'restore'; slideId: string };

/** One place that knows what every button on the preview screen does. */
export function applyEdit(edl: Edl, edit: EdlEdit): Edl {
  switch (edit.op) {
    case 'caption':
      return setCaption(edl, edit.slideId, edit.text);
    case 'longer':
      return nudgeDuration(edl, edit.slideId, NUDGE_SEC);
    case 'shorter':
      return nudgeDuration(edl, edit.slideId, -NUDGE_SEC);
    case 'move-up':
      return moveSlide(edl, edit.slideId, 'up');
    case 'move-down':
      return moveSlide(edl, edit.slideId, 'down');
    case 'swap':
      return swapPhoto(edl, edit.slideId, edit.replacement);
    case 'remove':
      return removeSlide(edl, edit.slideId);
    case 'restore':
      return restoreSlide(edl, edit.slideId);
  }
}

/**
 * After a structural edit the holds are refitted, because adding or removing a
 * slide changes what "five minutes" means for every other slide. A length nudge
 * is exempt: refitting the thing somebody just lengthened would undo it.
 */
export function applyEditAndRefit(edl: Edl, edit: EdlEdit): Edl {
  const edited = applyEdit(edl, edit);
  if (edit.op === 'longer' || edit.op === 'shorter' || edit.op === 'caption') return edited;
  return withFittedDurations(edited);
}
