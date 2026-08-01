/**
 * The program as four pages, and as plain text.
 *
 * Half-fold imposition — printing pages 4 and 1 on one side and 2 and 3 on the
 * other — is a printer's job, not ours. What we produce is the four pages in
 * reading order, clearly labelled, so that a family can print it at home and
 * fold it, or hand the same file to a print shop and say "half fold, saddle
 * stitch" and be understood.
 *
 * The plain-text version exists because funeral homes ask for one. They set the
 * program themselves in whatever they use, and an email they can paste from is
 * worth more than a beautiful PDF they cannot.
 */
import type { ProgramDocument } from '@col/schemas';

export type ProgramPage = {
  /** 1..4, in reading order. */
  number: number;
  /** "Page 1 — the front cover", said plainly on screen and on paper. */
  label: string;
  kind: 'cover' | 'order' | 'sketch' | 'back';
};

export const PROGRAM_PAGES: readonly ProgramPage[] = [
  { number: 1, label: 'Page 1 — the front cover', kind: 'cover' },
  { number: 2, label: 'Page 2 — the order of service', kind: 'order' },
  { number: 3, label: 'Page 3 — their life, and a reading', kind: 'sketch' },
  { number: 4, label: 'Page 4 — the back, and the thank you', kind: 'back' },
];

/** Paper the program is set for. A4 in most of the world, Letter in the US. */
export type PaperSize = 'a4' | 'letter';

export function isPaperSize(value: unknown): value is PaperSize {
  return value === 'a4' || value === 'letter';
}

export const PAPER_LABELS: Record<PaperSize, string> = {
  a4: 'A4 (210 × 297 mm)',
  letter: 'US Letter (8.5 × 11 in)',
};

/**
 * What to tell a print shop. Deliberately in their language, not ours: these
 * are the four words that get a folded program back instead of four loose
 * sheets.
 */
export const PRINT_SHOP_NOTE =
  'Four pages, in reading order, one page per sheet. For a folded program ask the ' +
  'printer for a half-fold (also called a bi-fold) booklet on one sheet of paper: ' +
  'they will put page 4 and page 1 on one side and pages 2 and 3 on the other. ' +
  'Every print shop does this every day — the words to use are "half fold, four page ' +
  'booklet, printed both sides".';

/* -------------------------------------------------------------------------- */
/* plain text                                                                  */
/* -------------------------------------------------------------------------- */

function rule(text: string): string {
  return '='.repeat(Math.min(Math.max(text.length, 8), 60));
}

/**
 * The whole program as text, for pasting into an email to the funeral home.
 *
 * Not a fallback for a rendering failure — some people simply want the words,
 * and a funeral director with the words can set the program in whatever they
 * already use.
 */
export function programToText(doc: ProgramDocument): string {
  const out: string[] = [];

  out.push(doc.coverLine || 'In Loving Memory');
  out.push(doc.fullName);
  out.push(rule(doc.fullName));
  if (doc.lifeDates) out.push(doc.lifeDates);
  if (doc.serviceLine) out.push(doc.serviceLine);
  out.push('');

  if (doc.orderOfService.length > 0) {
    out.push('ORDER OF SERVICE', '');
    for (const entry of doc.orderOfService) {
      out.push(entry.note ? `${entry.item} — ${entry.note}` : entry.item);
    }
    out.push('');
  }

  if (doc.lifeSketch.trim()) {
    out.push(`${doc.fullName.toUpperCase()}`, '');
    out.push(doc.lifeSketch.trim(), '');
  }

  if (doc.reading) {
    out.push(doc.reading.title.toUpperCase(), '');
    if (doc.reading.text) out.push(doc.reading.text.trim(), '');
    out.push(doc.reading.source, '');
  }

  if (doc.acknowledgments.trim()) {
    out.push('WITH THANKS', '', doc.acknowledgments.trim(), '');
  }

  if (doc.backNote.trim()) out.push(doc.backNote.trim(), '');

  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

/** Words on the printed page. Handy for "will this fit?" on the sketch screen. */
export function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => /[a-z0-9]/i.test(word)).length;
}

/**
 * Whether the life sketch is likely to fit page three at a readable size.
 *
 * Not a limit — a family may write what they like — but a quiet note beats
 * finding out at the print shop.
 */
export function sketchFitNote(text: string): string | undefined {
  const words = countWords(text);
  if (words === 0) return undefined;
  if (words > 400) {
    return `About ${words} words. That is longer than a page holds comfortably — it will be set small, or spill onto the back.`;
  }
  if (words > 300) return `About ${words} words. It will fit, set a little smaller.`;
  return `About ${words} words. That fits the page nicely.`;
}
