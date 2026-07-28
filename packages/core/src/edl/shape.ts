/**
 * The one decision on the story-shape screen.
 *
 * A family should not be asked to design an information architecture three days
 * after a death. So the screen asks one question — how should this be ordered?
 * — recommends an answer, says in one line why, and puts the other two options
 * underneath as quieter cards.
 *
 * The recommendation is computed here, from what the photographs actually
 * cover, and not by a model: a family that hands over eight decades gets
 * chronology because chronology is what eight decades are for, and a family
 * whose photographs all come from the last few years gets themes because a
 * timeline of four years is not a life, it is a hospital stay.
 */

export type StoryStructure = 'chrono' | 'thematic' | 'mixed';

/** Decades of spread that make a chronology worth watching. */
export const CHRONO_DECADE_SPREAD = 4;
/** At or below this, the photographs are clustered in one part of a life. */
export const CLUSTERED_DECADE_SPREAD = 2;
/** Below this share of dated photographs, we do not pretend to know the shape. */
export const MIN_DATED_SHARE = 0.4;

export type ShapeInput = {
  /** One entry per approved photograph: '1960s', 'unknown', null — whatever we have. */
  eras: readonly (string | null | undefined)[];
};

export type StructureOption = {
  id: StoryStructure;
  title: string;
  /** One line, in a family's words, about what this feels like to watch. */
  blurb: string;
};

export type ShapeRecommendation = {
  recommended: StoryStructure;
  /** One line, on screen, saying why this one. Always specific to their photos. */
  why: string;
  /** The recommendation first, then the two quieter alternatives. */
  options: StructureOption[];
  decadesCovered: number;
  datedPhotos: number;
  totalPhotos: number;
};

export const STRUCTURE_OPTIONS: Record<StoryStructure, StructureOption> = {
  chrono: {
    id: 'chrono',
    title: 'Beginning to end',
    blurb: 'Their life in order, from the earliest photographs to the last ones.',
  },
  thematic: {
    id: 'thematic',
    title: 'The things that mattered',
    blurb: 'Grouped by what filled their days — the people, the work, the garden.',
  },
  mixed: {
    id: 'mixed',
    title: 'Mostly in order',
    blurb: 'Roughly through their life, but keeping the photographs that belong together.',
  },
};

/** '1962' and '1960s' both mean the sixties; anything else means we do not know. */
export function decadeOf(era: string | null | undefined): number | undefined {
  if (!era) return undefined;
  const match = /(\d{4})/.exec(era);
  if (!match?.[1]) return undefined;
  const year = Number.parseInt(match[1], 10);
  if (!Number.isFinite(year) || year < 1800 || year > 2200) return undefined;
  return Math.floor(year / 10) * 10;
}

export function recommendStructure(input: ShapeInput): ShapeRecommendation {
  const decades = new Set<number>();
  let dated = 0;
  for (const era of input.eras) {
    const decade = decadeOf(era);
    if (decade === undefined) continue;
    dated += 1;
    decades.add(decade);
  }

  const totalPhotos = input.eras.length;
  const decadesCovered = decades.size;
  const datedShare = totalPhotos === 0 ? 0 : dated / totalPhotos;

  const { recommended, why } = decide({ decadesCovered, datedShare, dated });
  const rest = (['chrono', 'thematic', 'mixed'] as const).filter((id) => id !== recommended);

  return {
    recommended,
    why,
    options: [STRUCTURE_OPTIONS[recommended], ...rest.map((id) => STRUCTURE_OPTIONS[id])],
    decadesCovered,
    datedPhotos: dated,
    totalPhotos,
  };
}

function decide(input: { decadesCovered: number; datedShare: number; dated: number }): {
  recommended: StoryStructure;
  why: string;
} {
  if (input.dated === 0 || input.datedShare < MIN_DATED_SHARE) {
    return {
      recommended: 'mixed',
      why: 'Most of these photographs have no date on them, so a strict timeline would be guesswork.',
    };
  }
  if (input.decadesCovered >= CHRONO_DECADE_SPREAD) {
    return {
      recommended: 'chrono',
      why: `The photographs reach across ${input.decadesCovered} decades — enough that watching them in order tells the story on its own.`,
    };
  }
  if (input.decadesCovered <= CLUSTERED_DECADE_SPREAD) {
    return {
      recommended: 'thematic',
      why:
        input.decadesCovered <= 1
          ? 'Nearly all of these photographs come from the same few years, so grouping them by what was happening says more than a timeline would.'
          : 'These photographs sit close together in time, so what they are of matters more than what order they came in.',
    };
  }
  return {
    recommended: 'mixed',
    why: `The photographs cover ${input.decadesCovered} decades, with gaps — loosely in order, keeping like with like, suits them best.`,
  };
}
