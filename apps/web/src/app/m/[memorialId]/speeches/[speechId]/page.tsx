/**
 * One speech.
 *
 * The draft, full width, in the reading serif. The tools beside it. The history
 * underneath, so going back is always visible rather than remembered. And the
 * read-aloud timer, because the single most useful thing anybody can tell a
 * person giving a eulogy is "read it out loud once, and add a quarter".
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  REVISION_LABELS,
  describeSpeechLength,
  latestVersion,
  listVersions,
  notesOf,
  resumeSetupStep,
  speechTitle,
} from '@col/core';
import type { EulogyRevision } from '@col/ai';
import type { EulogyDraftRow } from '@col/db';
import { StepScreen, step } from '@/components/StepScreen';
import { db } from '@/server/db';
import { requireOrganizer } from '@/server/auth';
import { restoreVersionAction } from '../actions';
import { DraftTools } from './DraftTools';
import { ReadAloudTimer } from './ReadAloudTimer';
import { RemoveSpeech } from './RemoveSpeech';
import styles from '../speeches.module.css';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'A speech' };

const TOOL_ORDER: EulogyRevision[] = ['shorter', 'longer', 'warmer', 'simpler', 'graveside'];

export default async function SpeechPage({
  params,
  searchParams,
}: {
  params: Promise<{ memorialId: string; speechId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { memorialId, speechId } = await params;
  const query = (await searchParams) ?? {};
  const { memorial } = await requireOrganizer(memorialId);

  const wantsGraveside = query['variant'] === 'graveside';
  const full = latestVersion(db(), speechId);
  if (!full || full.memorialId !== memorialId) redirect(`/m/${memorialId}/speeches`);

  // A speech that never finished its setup goes back to where it stopped rather
  // than opening an empty studio.
  const unfinished = resumeSetupStep(full);
  if (unfinished && !full.body.trim()) {
    redirect(`/m/${memorialId}/speeches/${speechId}/setup/${unfinished}`);
  }

  const graveside = latestVersion(db(), speechId, 'graveside');
  const current = wantsGraveside && graveside ? graveside : full;
  const versions = listVersions(db(), speechId);
  const notes = notesOf(current);
  const written = current.body.trim().length > 0;

  const tools = TOOL_ORDER.filter((revision) => revision !== 'graveside' || !wantsGraveside).map(
    (revision) => ({
      revision,
      label: REVISION_LABELS[revision].label,
      help: REVISION_LABELS[revision].help,
    }),
  );

  return (
    <StepScreen
      wide
      eyebrow={`Remembering ${memorial.decedentName}`}
      title={wantsGraveside ? 'The graveside version' : speechTitle(current)}
      helper={
        written
          ? `${describeSpeechLength(current.body)} as written · aiming for ${current.targetMinutes} minutes`
          : 'Nothing written yet.'
      }
      secondary={
        <>
          <Link className={step.quiet} href={`/m/${memorialId}/speeches`}>
            All the speeches
          </Link>
          {written ? (
            <Link
              className={step.quiet}
              href={`/m/${memorialId}/speeches/${speechId}/print${
                wantsGraveside ? '?variant=graveside' : ''
              }`}
            >
              Print it large
            </Link>
          ) : null}
          {graveside && !wantsGraveside ? (
            <Link
              className={step.quiet}
              href={`/m/${memorialId}/speeches/${speechId}?variant=graveside`}
            >
              The graveside version
            </Link>
          ) : null}
          {wantsGraveside ? (
            <Link className={step.quiet} href={`/m/${memorialId}/speeches/${speechId}`}>
              Back to the full speech
            </Link>
          ) : null}
          <Link
            className={step.quiet}
            href={`/m/${memorialId}/speeches/${speechId}/setup/memories`}
          >
            Change the memories it uses
          </Link>
        </>
      }
      footer={
        <div className={styles.programLinks}>
          <span>
            This is your speech. Nothing here is published anywhere, and every version is kept.
          </span>
          <RemoveSpeech memorialId={memorialId} speechId={speechId} />
        </div>
      }
    >
      {notes.warnings.length > 0 ? (
        <section className={styles.warnings}>
          <h2 className={styles.warningsTitle}>Two small things we changed</h2>
          <ul className={styles.warningsList}>
            {notes.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <DraftTools
        memorialId={memorialId}
        speechId={speechId}
        body={current.body}
        versionKey={`${current.id}:${current.version}`}
        variant={current.variant}
        tools={tools}
        needsFirstDraft={!written}
        speakerLine={
          current.speakerName
            ? `${current.speakerName}, ${current.relationship ?? 'speaking'}.`
            : 'Ready when you are.'
        }
      />

      {written ? (
        <ReadAloudTimer body={current.body} targetMinutes={current.targetMinutes} />
      ) : null}

      {versions.length > 1 ? (
        <section className={styles.section} style={{ marginTop: '40px' }}>
          <h2 className={styles.sectionTitle}>Earlier versions</h2>
          <ul className={styles.history}>
            {versions.map((version) => (
              <li key={version.id} className={styles.historyRow}>
                <span className={styles.historyNote}>
                  {version.note ?? 'A version'}
                  {version.variant === 'graveside' ? ' · graveside' : ''}
                </span>
                <span className={styles.historyWhen}>{whenLabel(version)}</span>
                {version.id === current.id ? (
                  <span className={styles.historyWhen}>on screen now</span>
                ) : (
                  <form action={restoreVersionAction} className={styles.inlineForm}>
                    <input type="hidden" name="memorialId" value={memorialId} />
                    <input type="hidden" name="speechId" value={speechId} />
                    <input type="hidden" name="versionId" value={version.id} />
                    <button type="submit" className={step.quiet}>
                      Put this one back
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </StepScreen>
  );
}

function whenLabel(version: EulogyDraftRow): string {
  const when = new Date(version.createdAt).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `version ${version.version} · ${when}`;
}
