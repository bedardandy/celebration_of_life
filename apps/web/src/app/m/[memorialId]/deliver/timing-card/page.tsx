/**
 * The timing card: a silent video and a live song, made to work together.
 *
 * Printed and handed to whoever is at the back with the sound desk, or the
 * nephew with the phone and the aux cable. The cue is something they can see —
 * the screen coming up out of black — because they will be watching the room,
 * not a stopwatch. And the last line gives them permission to be a few seconds
 * out, which is both true and the difference between a calm person and a
 * panicking one.
 */
import Link from 'next/link';
import type { CutName } from '@col/schemas';
import {
  buildTimingCard,
  cardToText,
  latestProject,
  latestRender,
  musicChoice,
  projectCut,
  projectEdl,
} from '@col/core';
import { db } from '@/server/db';
import { requireOrganizer } from '@/server/auth';
import styles from '../print.module.css';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Timing card for the venue' };

export default async function TimingCardPage({
  params,
  searchParams,
}: {
  params: Promise<{ memorialId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { memorialId } = await params;
  const query = (await searchParams) ?? {};
  const { memorial } = await requireOrganizer(memorialId);

  const cut: CutName = query['cut'] === 'family' ? 'family' : 'service';
  const project = latestProject(db(), memorialId);
  const edl = projectEdl(project);
  const timeline = edl ? projectCut(edl, cut) : undefined;
  const render = latestRender(db(), memorialId, cut, 'final1080');
  const choice = musicChoice(db(), project);

  if (choice.mode !== 'sideloaded') {
    return (
      <main className={styles.sheet}>
        <nav className={styles.screenOnly}>
          <Link href={`/m/${memorialId}/deliver?cut=${cut}`}>Back to the video</Link>
        </nav>
        <h1 className={styles.title}>No timing card is needed</h1>
        <p className={styles.note}>
          The music is inside this video, so nobody has to play anything alongside it. The card for
          the funeral director covers everything they need.
        </p>
        <p className={styles.screenOnly}>
          <Link href={`/m/${memorialId}/deliver/card?cut=${cut}`}>Open that card instead</Link>
        </p>
      </main>
    );
  }

  const card = buildTimingCard({
    decedentName: memorial.decedentName,
    songTitle: choice.selection?.sideloadedTitle ?? 'The song the family chose',
    ...(choice.selection?.sideloadedArtist
      ? { songArtist: choice.selection.sideloadedArtist }
      : {}),
    durationSec: render?.durationSec ?? timeline?.totalSec ?? 0,
    ...(edl?.audio.beatGrid?.bpm ? { bpm: edl.audio.beatGrid.bpm } : {}),
  });

  return (
    <main className={styles.sheet}>
      <nav className={styles.screenOnly}>
        <Link href={`/m/${memorialId}/deliver?cut=${cut}`}>Back to the video</Link>
        <span className={styles.printHint}>Print this page, or copy the text at the bottom.</span>
      </nav>

      <h1 className={styles.title}>{card.title}</h1>
      <p className={styles.subtitle}>For whoever is playing the song</p>

      <dl className={styles.lines}>
        {card.lines.map((line) => (
          <div key={line.label} className={styles.line}>
            <dt className={styles.label}>{line.label}</dt>
            <dd className={styles.value}>{line.value}</dd>
          </div>
        ))}
      </dl>

      <p className={styles.emphasis}>{card.emphasis}</p>

      <h2 className={styles.heading}>{card.checklistTitle}</h2>
      <ol className={styles.checklist}>
        {card.checklist.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ol>

      <section className={styles.screenOnly}>
        <h2 className={styles.heading}>The same thing as text</h2>
        <p className={styles.note}>
          <a href={`/api/deliver/${memorialId}/card.txt?cut=${cut}&kind=timing`}>
            Open as plain text
          </a>
        </p>
        <pre className={styles.text}>{cardToText(card)}</pre>
      </section>
    </main>
  );
}
