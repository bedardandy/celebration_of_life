/**
 * The program, as it will print.
 *
 * Four pages in reading order, each one labelled on screen so nobody has to
 * guess which is which, and each one breaking onto its own sheet when printed.
 * Half-fold imposition is left to the print shop — the note at the bottom says
 * exactly what to ask them for, in their words.
 *
 * The same content sits underneath as plain text, because funeral homes ask for
 * it and an email they can paste from is worth more than a file they cannot
 * open.
 */
import Link from 'next/link';
import {
  PAPER_LABELS,
  PRINT_SHOP_NOTE,
  PROGRAM_PAGES,
  currentProgram,
  isPaperSize,
  programToText,
  type PaperSize,
} from '@col/core';
import type { ProgramDocument } from '@col/schemas';
import { db } from '@/server/db';
import { requireOrganizer } from '@/server/auth';
import styles from './program-print.module.css';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'The program, as it will print' };

export default async function ProgramPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ memorialId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { memorialId } = await params;
  const query = (await searchParams) ?? {};
  const { memorial } = await requireOrganizer(memorialId);

  const requested = query['paper'];
  const paper: PaperSize = isPaperSize(requested) ? requested : 'a4';
  const { doc } = currentProgram(db(), memorial);
  const other: PaperSize = paper === 'a4' ? 'letter' : 'a4';

  return (
    <main className={`${styles.sheets} ${paper === 'letter' ? styles.letter : styles.a4}`}>
      <nav className={styles.screenOnly}>
        <Link href={`/m/${memorialId}/program`}>Back to the program</Link>
        <span className={styles.printHint}>
          Set for {PAPER_LABELS[paper]}.{' '}
          <Link href={`/m/${memorialId}/program/print?paper=${other}`}>
            Set it for {PAPER_LABELS[other]} instead
          </Link>
          . Print it, then fold — or send this to a print shop with the note at the bottom.
        </span>
      </nav>

      {PROGRAM_PAGES.map((page) => (
        <section key={page.number} className={styles.page}>
          <p className={styles.pageLabel}>{page.label}</p>
          <PageBody kind={page.kind} doc={doc} memorialId={memorialId} />
        </section>
      ))}

      <section className={styles.screenOnly}>
        <h2 className={styles.textTitle}>What to ask a print shop for</h2>
        <p className={styles.note}>{PRINT_SHOP_NOTE}</p>

        <h2 className={styles.textTitle}>The same thing as text</h2>
        <p className={styles.note}>
          For an email to the funeral home, who will often set the program themselves.{' '}
          <a href={`/api/program/${memorialId}/program.txt`}>Open as plain text</a>
        </p>
        <pre className={styles.text}>{programToText(doc)}</pre>
      </section>
    </main>
  );
}

function PageBody({
  kind,
  doc,
  memorialId,
}: {
  kind: (typeof PROGRAM_PAGES)[number]['kind'];
  doc: ProgramDocument;
  memorialId: string;
}) {
  if (kind === 'cover') {
    return (
      <div className={styles.cover}>
        <p className={styles.coverLine}>{doc.coverLine || 'In Loving Memory'}</p>
        {doc.coverAssetId ? (
          <img
            className={styles.portrait}
            src={`/api/assets/${doc.coverAssetId}?variant=web1600`}
            alt={doc.fullName}
          />
        ) : (
          <div className={styles.portraitBlank} aria-hidden="true" />
        )}
        <h1 className={styles.coverName}>{doc.fullName}</h1>
        {doc.lifeDates ? <p className={styles.coverDates}>{doc.lifeDates}</p> : null}
        {doc.serviceLine ? <p className={styles.coverService}>{doc.serviceLine}</p> : null}
      </div>
    );
  }

  if (kind === 'order') {
    return (
      <div>
        <h2 className={styles.pageTitle}>Order of Service</h2>
        {doc.orderOfService.length === 0 ? (
          <p className={styles.note}>
            Nothing here yet.{' '}
            <Link href={`/m/${memorialId}/program/order`}>Fill in the order of service</Link>.
          </p>
        ) : (
          <ol className={styles.order}>
            {doc.orderOfService.map((entry, index) => (
              <li key={`${entry.item}-${index}`} className={styles.orderItem}>
                <span className={styles.orderName}>{entry.item}</span>
                {entry.note ? <span className={styles.orderNote}>{entry.note}</span> : null}
              </li>
            ))}
          </ol>
        )}
      </div>
    );
  }

  if (kind === 'sketch') {
    return (
      <div>
        <h2 className={styles.pageTitle}>{doc.fullName}</h2>
        {doc.lifeSketch.trim() ? (
          doc.lifeSketch.split(/\n\s*\n/).map((paragraph, index) => (
            <p key={index} className={styles.body}>
              {paragraph.trim()}
            </p>
          ))
        ) : (
          <p className={styles.note}>
            The life sketch is empty.{' '}
            <Link href={`/m/${memorialId}/program/sketch`}>Write or draft it</Link>.
          </p>
        )}

        {doc.reading ? (
          <div className={styles.reading}>
            <h3 className={styles.readingTitle}>{doc.reading.title}</h3>
            {doc.reading.text ? (
              <p className={styles.readingText}>{doc.reading.text}</p>
            ) : (
              <p className={styles.note}>
                To be read on the day. Ask whoever is leading for the text they use.
              </p>
            )}
            <p className={styles.readingSource}>{doc.reading.source}</p>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className={styles.back}>
      <h2 className={styles.pageTitle}>With thanks</h2>
      <p className={styles.body}>{doc.acknowledgments}</p>
      {doc.backNote.trim() ? <p className={styles.backNote}>{doc.backNote}</p> : null}
    </div>
  );
}
