import Link from 'next/link';
import {
  computeChecklist,
  currentDoc,
  dashboardBanner,
  formatServiceDate,
  resumeIntakeStep,
  subjectOf,
  type ChecklistCard,
  type DeadlineBanner,
} from '@col/core';
import { getPack } from '@col/tradition-packs';
import {
  and,
  countWhere,
  eq,
  isNull,
  mediaAssets,
  memorials,
  memoryNotes,
  updateById,
} from '@col/db';
import { StepScreen } from '@/components/StepScreen';
import { db } from '@/server/db';
import { requireOrganizer } from '@/server/auth';
import { RemoveMemorial } from './RemoveMemorial';
import styles from './dashboard.module.css';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ memorialId: string }> }) {
  const { memorialId } = await params;
  const memorial = db().select().from(memorials).where(eq(memorials.id, memorialId)).all()[0];
  return { title: memorial ? `Remembering ${memorial.decedentName}` : 'Memorial' };
}

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ memorialId: string }>;
}) {
  const { memorialId } = await params;
  const { memorial } = await requireOrganizer(memorialId);

  const counts = {
    photos: countWhere(
      db(),
      mediaAssets,
      and(eq(mediaAssets.memorialId, memorialId), isNull(mediaAssets.deletedAt)),
    ),
    memories: countWhere(
      db(),
      memoryNotes,
      and(eq(memoryNotes.memorialId, memorialId), isNull(memoryNotes.deletedAt)),
    ),
    // The interview's own measure of progress: chapters a family can read back.
    storyChapters: currentDoc(db(), memorialId, subjectOf(memorial)).doc.chapters.length,
  };

  const checklist = computeChecklist(memorial, counts);
  // The checklist is stored so later phases (and the worker) can read progress
  // without recomputing it, and so a diff over time is possible.
  updateById(db(), memorials, memorialId, { checklist: checklist.flags });

  const banner = dashboardBanner({
    pacingPreset: memorial.pacingPreset,
    serviceDate: memorial.serviceDate,
    nextStep: checklist.nextStep,
  });

  const pack = getPack(memorial.traditionSlug);
  const placement = pack.mediaPlacement[0];
  const unfinishedStep = resumeIntakeStep(memorial);

  return (
    <StepScreen
      wide
      eyebrow="Celebration of Life"
      title={`Remembering ${memorial.decedentName}`}
      helper={
        memorial.serviceDate
          ? `Service: ${formatServiceDate(memorial.serviceDate, memorial.timezone)}`
          : 'No service date yet.'
      }
      footer={
        <div className={styles.footerRow}>
          <span>Everything here saves as you go.</span>
          <RemoveMemorial memorialId={memorialId} />
        </div>
      }
    >
      <Banner banner={banner} />

      {unfinishedStep ? (
        <p className={styles.bannerStep}>
          <Link href={`/m/${memorialId}/intake/${unfinishedStep}`}>
            There are a few questions left, whenever you want them.
          </Link>
        </p>
      ) : null}

      <div className={styles.cards}>
        {checklist.cards.map((card) => (
          <DashboardCard key={card.id} card={card} />
        ))}
      </div>

      {placement ? (
        <aside className={styles.note}>
          <h2 className={styles.noteTitle}>{placement.context}</h2>
          <p className={styles.noteBody}>{placement.guidance}</p>
        </aside>
      ) : null}
    </StepScreen>
  );
}

function Banner({ banner }: { banner: DeadlineBanner }) {
  const toneClass = {
    urgent: styles.bannerUrgent,
    soon: styles.bannerSoon,
    steady: styles.bannerSteady,
    open: styles.bannerOpen,
  }[banner.tone];

  return (
    <section className={`${styles.banner} ${toneClass}`}>
      <p className={styles.bannerHeadline}>{banner.headline}</p>
      <p className={styles.bannerStep}>{banner.nextStep}</p>
    </section>
  );
}

function DashboardCard({ card }: { card: ChecklistCard }) {
  if (card.state === 'locked') {
    return (
      <div className={`${styles.card} ${styles.cardLocked}`} aria-disabled="true">
        <h2 className={styles.cardTitle}>{card.title}</h2>
        <p className={styles.cardHelp}>{card.help}</p>
        <p className={styles.cardStatus}>{card.lockedReason}</p>
      </div>
    );
  }

  return (
    <Link className={styles.card} href={card.href}>
      <h2 className={styles.cardTitle}>{card.title}</h2>
      <p className={styles.cardHelp}>{card.help}</p>
      <p className={`${styles.cardStatus} ${card.state === 'ready' ? styles.cardReady : ''}`}>
        {card.statusLine}
      </p>
    </Link>
  );
}
