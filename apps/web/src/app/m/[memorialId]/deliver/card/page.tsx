/**
 * The funeral director's card, printed.
 *
 * One page, black on white, no navigation, no branding, nothing that costs ink.
 * It exists because the person who will actually press play has never met this
 * family and will be handed a USB stick twenty minutes before a service, and
 * because "please test it first" is the single sentence that prevents the
 * failure this whole product is organised around.
 *
 * The same words are available as plain text — some funeral homes want an email,
 * not an attachment.
 */
import Link from 'next/link';
import type { CutName, RenderPreset } from '@col/schemas';
import {
  buildDirectorCard,
  cardToText,
  formatServiceDate,
  latestProject,
  latestRender,
  projectCut,
  projectEdl,
  summariseMusic,
} from '@col/core';
import { getPack } from '@col/tradition-packs';
import { db } from '@/server/db';
import { requireOrganizer } from '@/server/auth';
import styles from '../print.module.css';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Card for the funeral director' };

const PRESETS: RenderPreset[] = ['final1080', 'backup720', 'draft360'];

export default async function DirectorCardPage({
  params,
  searchParams,
}: {
  params: Promise<{ memorialId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { memorialId } = await params;
  const query = (await searchParams) ?? {};
  const { memorial, participant } = await requireOrganizer(memorialId);

  const cut: CutName = query['cut'] === 'family' ? 'family' : 'service';
  const requested = String(query['preset'] ?? 'final1080');
  const preset = (
    PRESETS.includes(requested as RenderPreset) ? requested : 'final1080'
  ) as RenderPreset;

  const project = latestProject(db(), memorialId);
  const edl = projectEdl(project);
  const timeline = edl ? projectCut(edl, cut) : undefined;
  const render = latestRender(db(), memorialId, cut, preset);
  const probe = (render?.ffprobeMeta ?? {}) as { width?: number; height?: number };
  const music = summariseMusic(db(), project);
  const pack = getPack(memorial.traditionSlug);

  const card = buildDirectorCard({
    decedentName: memorial.decedentName,
    cut,
    preset,
    durationSec: render?.durationSec ?? timeline?.totalSec ?? 0,
    ...(probe.width ? { width: probe.width } : {}),
    ...(probe.height ? { height: probe.height } : {}),
    audioMode: music.mode,
    ...(pack.mediaPlacement[0] ? { placementNote: pack.mediaPlacement[0] } : {}),
    ...(memorial.serviceDate
      ? { serviceDateLabel: formatServiceDate(memorial.serviceDate, memorial.timezone) }
      : {}),
    ...(participant.displayName ? { organizerName: participant.displayName } : {}),
    ...(participant.email ? { organizerContact: participant.email } : {}),
  });

  return (
    <main className={styles.sheet}>
      <nav className={styles.screenOnly}>
        <Link href={`/m/${memorialId}/deliver?cut=${cut}`}>Back to the video</Link>
        <span className={styles.printHint}>Print this page, or copy the text at the bottom.</span>
      </nav>

      <h1 className={styles.title}>{card.title}</h1>
      <p className={styles.subtitle}>For whoever is playing the video</p>

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

      {card.placementNote ? (
        <>
          <h2 className={styles.heading}>{card.placementNote.context}</h2>
          <p className={styles.note}>{card.placementNote.guidance}</p>
        </>
      ) : null}

      {render == null ? (
        <p className={styles.note}>
          This card describes the video once it has been made. The length and format will be exact
          after the render finishes.
        </p>
      ) : null}

      <section className={styles.screenOnly}>
        <h2 className={styles.heading}>The same thing as text</h2>
        <p className={styles.note}>
          For an email, or for reading down the telephone.{' '}
          <a href={`/api/deliver/${memorialId}/card.txt?cut=${cut}&preset=${preset}`}>
            Open as plain text
          </a>
        </p>
        <pre className={styles.text}>{cardToText(card)}</pre>
      </section>
    </main>
  );
}
