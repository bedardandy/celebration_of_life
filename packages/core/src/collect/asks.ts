/**
 * Bounded asks.
 *
 * Delegation is the mechanic that actually takes weight off an organiser, and
 * the research is blunt about why it usually fails: "send me any photos you
 * have" asks a grieving cousin to make decisions, so the photos never arrive.
 * A bounded ask — five to ten, of one thing, by Wednesday — arrives.
 *
 * So an ask is a small piece of data, not free text: a template the organiser
 * picks, a name, and an optional date. The contributor's landing page then says
 * the specific thing that was asked of them, in the second person, and their
 * upload page carries the same sentence so they can see when they are done.
 */

export type AskTemplateSlug =
  | 'recent-photos'
  | 'younger-years'
  | 'era-or-theme'
  | 'one-story'
  | 'anything';

export type AskTemplate = {
  slug: AskTemplateSlug;
  /** What the organiser sees in the picker. */
  label: string;
  /** One line under it, so the choice needs no thought. */
  hint: string;
  /** The heading on the contributor's page. `{name}` = the person who died. */
  heading: string;
  /** The ask itself, in the second person. */
  body: string;
  /** Rough number of photos this ask is asking for. Shown as reassurance. */
  suggestedCount?: string;
};

export const ASK_TEMPLATES: AskTemplate[] = [
  {
    slug: 'recent-photos',
    label: 'Recent photos',
    hint: 'The last few years — phones, holidays, ordinary days.',
    heading: 'Photos of {name} from recent years',
    body: 'Could you add five or ten photos of {name} from the last few years? Ordinary days are just as welcome as big occasions.',
    suggestedCount: '5–10 photos',
  },
  {
    slug: 'younger-years',
    label: 'Younger years',
    hint: 'Childhood, their twenties, early family life.',
    heading: 'Photos of {name} when they were young',
    body: 'Could you add any photos you have of {name} from earlier in their life? Old prints are perfect — a photo of the photo works.',
    suggestedCount: '5–10 photos',
  },
  {
    slug: 'era-or-theme',
    label: 'A particular time or thing',
    hint: 'A decade, a house, the boat, the choir.',
    heading: 'Photos of {name}: {focus}',
    body: 'Could you add any photos you have of {focus}? Even one or two would help.',
    suggestedCount: 'A few photos',
  },
  {
    slug: 'one-story',
    label: 'One story',
    hint: 'No photos needed — just the thing they always tell.',
    heading: 'One story about {name}',
    body: "Could you write down one story about {name} you'll never forget? A few sentences is plenty.",
  },
  {
    slug: 'anything',
    label: 'Anything they have',
    hint: 'The open ask. Best for people who have a shoebox.',
    heading: 'Photos and memories of {name}',
    body: 'Could you add any photos of {name} that you have? Anything at all is welcome, and you can come back and add more later.',
    suggestedCount: 'As many as you like',
  },
];

export const DEFAULT_ASK_TEMPLATE: AskTemplateSlug = 'anything';

export function getAskTemplate(slug: string | null | undefined): AskTemplate {
  return (
    ASK_TEMPLATES.find((t) => t.slug === slug) ??
    (ASK_TEMPLATES.find((t) => t.slug === DEFAULT_ASK_TEMPLATE) as AskTemplate)
  );
}

export function isAskTemplateSlug(value: unknown): value is AskTemplateSlug {
  return typeof value === 'string' && ASK_TEMPLATES.some((t) => t.slug === value);
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);
}

export type RenderedAsk = {
  heading: string;
  body: string;
  suggestedCount?: string;
  /** "It would help to have these by Sunday." Never a countdown, never red. */
  deadlineLine?: string;
};

/**
 * The ask as the contributor reads it. A deadline is phrased as help, not as a
 * cut-off, because the link keeps working afterwards and saying otherwise would
 * be a lie people would act on.
 */
export function renderAsk(input: {
  templateSlug?: string | null;
  decedentName: string;
  focus?: string | null;
  /** Free text the organiser wrote instead of the template body. */
  note?: string | null;
  deadlineAt?: number | null;
  timezone?: string;
  now?: number;
}): RenderedAsk {
  const template = getAskTemplate(input.templateSlug);
  const values = {
    name: input.decedentName,
    focus: (input.focus ?? '').trim() || 'that time',
  };
  const body = (input.note ?? '').trim() || fill(template.body, values);
  const deadlineLine = input.deadlineAt
    ? `It would help to have these by ${formatDeadline(input.deadlineAt, input.timezone)}.`
    : undefined;

  return {
    heading: fill(template.heading, values),
    body,
    ...(template.suggestedCount ? { suggestedCount: template.suggestedCount } : {}),
    ...(deadlineLine ? { deadlineLine } : {}),
  };
}

/** A weekday and a date, which is how people say a deadline out loud. */
export function formatDeadline(at: number, timezone = 'UTC'): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      timeZone: timezone,
    }).format(new Date(at));
  } catch {
    return new Intl.DateTimeFormat('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }).format(new Date(at));
  }
}
