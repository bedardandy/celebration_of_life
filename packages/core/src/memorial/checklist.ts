/**
 * What the dashboard shows, decided in one place.
 *
 * The dashboard has to answer exactly one question — "what would help right
 * now?" — and it has to answer it without ever showing a blank page or a
 * scolding empty state. So the card states, the one-line status under each
 * card, and the single suggested next step are all computed here from counts,
 * and the component only renders what it is handed.
 */
import type { Memorial } from '@col/db';

/** Enough photos that a five-minute tribute has something to work with. */
export const MIN_PHOTOS_FOR_SLIDESHOW = 10;
/** Enough for the slideshow to carry a voice rather than just faces. */
export const MIN_MEMORIES_FOR_SLIDESHOW = 1;
/** A comfortable target — 60–80 photos at 3–7 seconds fills five minutes. */
export const COMFORTABLE_PHOTO_COUNT = 40;
export const COMFORTABLE_MEMORY_COUNT = 5;
/** Enough chapters that the story has an arc rather than a highlight. */
export const COMFORTABLE_CHAPTER_COUNT = 3;

export type ChecklistCounts = {
  photos: number;
  memories: number;
  /**
   * Chapters in the current LifeStoryDocument. Optional because the interview
   * is a later phase than this file, and a memorial that has never been
   * interviewed has no document to count — which is not the same as zero.
   */
  storyChapters?: number;
  /**
   * How far the slideshow itself has got. Optional for the same reason
   * `storyChapters` is: a memorial that has never opened the slideshow has no
   * project, which is not the same as a project with nothing in it.
   */
  slideshow?: {
    /** A generated EDL exists — there is something to watch. */
    hasEdl: boolean;
    /** Slides in the family cut. */
    slideCount?: number;
    /** "about 5 minutes", already phrased for a person. */
    lengthLabel?: string;
    /** A generate-edl job is on the queue right now. */
    building?: boolean;
  };
};

export type CardId = 'photos' | 'story' | 'slideshow';

export type CardState = 'not-started' | 'in-progress' | 'ready' | 'locked';

export type ChecklistCard = {
  id: CardId;
  title: string;
  /** One short line under the title. Never more than one. */
  help: string;
  state: CardState;
  /** The current situation in plain words. Always says something kind. */
  statusLine: string;
  href: string;
  /** Present only for locked cards; explains the lock without a telling-off. */
  lockedReason?: string;
};

export type Checklist = {
  cards: ChecklistCard[];
  /** Persisted on `memorials.checklist` so a later phase can diff progress. */
  flags: Record<string, boolean>;
  /** The one thing worth doing next, phrased for the deadline banner. */
  nextStep: string;
  readyToBuild: boolean;
};

function photosCard(memorialId: string, counts: ChecklistCounts): ChecklistCard {
  const base = {
    id: 'photos' as const,
    title: 'Collect photos',
    help: 'Send one link. Family and friends add photos without signing up.',
    href: `/m/${memorialId}/photos`,
  };
  if (counts.photos === 0) {
    return {
      ...base,
      state: 'not-started',
      statusLine: 'Nothing here yet. Most families start by sending the link to a few people.',
    };
  }
  if (counts.photos < COMFORTABLE_PHOTO_COUNT) {
    return {
      ...base,
      state: 'in-progress',
      statusLine: `${counts.photos} ${counts.photos === 1 ? 'photo' : 'photos'} so far. More will keep arriving.`,
    };
  }
  return {
    ...base,
    state: 'ready',
    statusLine: `${counts.photos} photos. That is plenty to work with.`,
  };
}

function storyCard(memorialId: string, counts: ChecklistCounts): ChecklistCard {
  const base = {
    id: 'story' as const,
    title: 'Tell their story',
    help: 'A few questions at a time. Skip anything. Come back whenever you like.',
    href: `/m/${memorialId}/story`,
  };
  const chapters = counts.storyChapters ?? 0;

  if (counts.memories === 0 && chapters === 0) {
    return {
      ...base,
      state: 'not-started',
      statusLine: 'Not started. The first question takes about a minute to answer.',
    };
  }

  // Once the interview has produced chapters, that is the better measure of
  // progress: it is the thing the family can actually read back.
  if (chapters > 0) {
    const shape = `Their story is taking shape — ${chapters} ${chapters === 1 ? 'chapter' : 'chapters'} so far.`;
    return {
      ...base,
      state: chapters >= COMFORTABLE_CHAPTER_COUNT ? 'ready' : 'in-progress',
      statusLine:
        counts.memories > 0
          ? `${shape} ${counts.memories} ${counts.memories === 1 ? 'memory' : 'memories'} from others.`
          : shape,
    };
  }

  if (counts.memories < COMFORTABLE_MEMORY_COUNT) {
    return {
      ...base,
      state: 'in-progress',
      statusLine: `${counts.memories} ${counts.memories === 1 ? 'memory' : 'memories'} written down.`,
    };
  }
  return {
    ...base,
    state: 'ready',
    statusLine: `${counts.memories} memories written down. Their story is taking shape.`,
  };
}

function slideshowCard(memorialId: string, counts: ChecklistCounts): ChecklistCard {
  const base = {
    id: 'slideshow' as const,
    title: 'Build the slideshow',
    help: 'Photos and music, timed for the service.',
    href: `/m/${memorialId}/slideshow`,
  };
  const slideshow = counts.slideshow;

  // Once something exists, it outranks every threshold: a family watching their
  // own slideshow must never be told the card is locked.
  if (slideshow?.hasEdl) {
    const slides = slideshow.slideCount ?? 0;
    const length = slideshow.lengthLabel ? `, about ${slideshow.lengthLabel}` : '';
    return {
      ...base,
      title: 'Watch the slideshow',
      help: 'Play it through and change anything that is not right.',
      href: `/m/${memorialId}/preview`,
      state: 'ready',
      statusLine: `A first version is ready — ${slides} ${slides === 1 ? 'slide' : 'slides'}${length}.`,
    };
  }

  if (slideshow?.building) {
    return {
      ...base,
      href: `/m/${memorialId}/preview`,
      state: 'in-progress',
      statusLine: 'Putting it together now — a minute or two.',
    };
  }

  const enoughPhotos = counts.photos >= MIN_PHOTOS_FOR_SLIDESHOW;
  const enoughMemories = counts.memories >= MIN_MEMORIES_FOR_SLIDESHOW;
  if (!enoughPhotos || !enoughMemories) {
    return {
      ...base,
      state: 'locked',
      statusLine: 'Waiting on a little more to work with.',
      lockedReason: 'This opens once you have a few photos and memories.',
    };
  }
  return {
    ...base,
    state: 'not-started',
    statusLine: 'Ready when you are. We suggest an order; you can change it.',
  };
}

/**
 * `memorial` is taken for its intake answers — later phases read the tradition
 * and the service date from it — and `counts` for everything that is gathered.
 */
export function computeChecklist(
  memorial: Pick<Memorial, 'id' | 'intakeCompletedAt'>,
  counts: ChecklistCounts,
): Checklist {
  const photos = photosCard(memorial.id, counts);
  const story = storyCard(memorial.id, counts);
  const slideshow = slideshowCard(memorial.id, counts);
  const cards = [photos, story, slideshow];

  const readyToBuild = slideshow.state !== 'locked';

  return {
    cards,
    flags: {
      intakeComplete: memorial.intakeCompletedAt != null,
      hasPhotos: counts.photos > 0,
      hasMemories: counts.memories > 0,
      hasStory: (counts.storyChapters ?? 0) > 0,
      enoughPhotos: counts.photos >= MIN_PHOTOS_FOR_SLIDESHOW,
      readyToBuild,
      hasSlideshow: counts.slideshow?.hasEdl === true,
    },
    nextStep: suggestNextStep(counts, readyToBuild),
    readyToBuild,
  };
}

/**
 * One sentence, always actionable, never a list. Photos come first because
 * they are the thing other people can help with, and delegation is the part
 * that actually takes weight off the organiser.
 */
export function suggestNextStep(counts: ChecklistCounts, readyToBuild: boolean): string {
  if (counts.slideshow?.hasEdl) {
    return 'The slideshow is ready to watch — see whether it sounds like them.';
  }
  if (counts.slideshow?.building) {
    return 'The slideshow is being put together. Nothing else needs you right now.';
  }
  if (counts.photos < MIN_PHOTOS_FOR_SLIDESHOW) {
    return 'The most helpful next step is gathering a few photos.';
  }
  if (counts.memories < MIN_MEMORIES_FOR_SLIDESHOW) {
    return 'The most helpful next step is writing down one memory.';
  }
  if (!readyToBuild) {
    return 'The most helpful next step is gathering a few more photos.';
  }
  if (counts.photos < COMFORTABLE_PHOTO_COUNT) {
    return 'You have enough to start the slideshow, and photos can keep arriving after that.';
  }
  return 'You have what you need. Building the slideshow is the next step.';
}
