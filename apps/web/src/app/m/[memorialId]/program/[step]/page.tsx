/**
 * One decision per screen, again.
 *
 * The cover photograph, the order of service, the life sketch, a reading, the
 * thank you. Nothing on any of these screens starts empty: the order arrives
 * filled in from the family's own tradition, the acknowledgement is already
 * written, and the life sketch can be drafted from the story they have already
 * told us.
 */
import { notFound } from 'next/navigation';
import Link from 'next/link';
import {
  PROGRAM_STEPS,
  approvedAssets,
  currentProgram,
  isProgramStep,
  previousProgramStep,
  programStepIndex,
  readingSuggestions,
  sketchFitNote,
  type ProgramStep,
} from '@col/core';
import type { ProgramDocument } from '@col/schemas';
import type { Memorial } from '@col/db';
import { StepScreen, step as stepStyles } from '@/components/StepScreen';
import { db } from '@/server/db';
import { requireOrganizer } from '@/server/auth';
import {
  continueProgramAction,
  orderItemAction,
  saveCoverAction,
  saveReadingAction,
  saveThanksAction,
} from '../actions';
import { SketchEditor } from '../SketchEditor';
import styles from '../program.module.css';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'The printed program' };

const COPY: Record<ProgramStep, { title: string; helper: string }> = {
  cover: {
    title: 'Which photograph goes on the front?',
    helper: 'One face, looking like themselves. It is printed small, so closer is better.',
  },
  order: {
    title: 'What happens, in order?',
    helper: 'Filled in the way services like this usually run. Change anything that is not right.',
  },
  sketch: {
    title: 'Their life, in a paragraph or two',
    helper: 'Read by people who knew them and people who did not. Around two hundred words.',
  },
  reading: {
    title: 'Is there a reading or a verse?',
    helper: 'Plenty of families have none. If you have your own, paste it in.',
  },
  thanks: {
    title: 'The thank you on the back',
    helper: 'Already written out. Change it to sound like your family.',
  },
};

export default async function ProgramStepPage({
  params,
}: {
  params: Promise<{ memorialId: string; step: string }>;
}) {
  const { memorialId, step: rawStep } = await params;
  if (!isProgramStep(rawStep)) notFound();
  const { memorial } = await requireOrganizer(memorialId);
  const { doc } = currentProgram(db(), memorial);

  const back = previousProgramStep(rawStep);
  const copy = COPY[rawStep];

  return (
    <StepScreen
      wide
      eyebrow={`Remembering ${memorial.decedentName}`}
      title={copy.title}
      helper={copy.helper}
      progress={{ current: programStepIndex(rawStep) + 1, total: PROGRAM_STEPS.length }}
      primary={
        rawStep === 'order' || rawStep === 'sketch' ? (
          <form action={continueProgramAction}>
            <input type="hidden" name="memorialId" value={memorialId} />
            <input type="hidden" name="step" value={rawStep} />
            <button type="submit" className={stepStyles.primary}>
              Continue
            </button>
          </form>
        ) : undefined
      }
      secondary={
        <>
          <Link className={stepStyles.quiet} href={`/m/${memorialId}/program`}>
            All five steps
          </Link>
          {back ? (
            <Link className={stepStyles.quiet} href={`/m/${memorialId}/program/${back}`}>
              Back
            </Link>
          ) : null}
        </>
      }
      footer="Everything saves as you go, and every version is kept."
    >
      <StepBody memorialId={memorialId} stepValue={rawStep} doc={doc} memorial={memorial} />
    </StepScreen>
  );
}

function StepBody({
  memorialId,
  stepValue,
  doc,
  memorial,
}: {
  memorialId: string;
  stepValue: ProgramStep;
  doc: ProgramDocument;
  memorial: Memorial;
}) {
  if (stepValue === 'cover') {
    const assets = approvedAssets(db(), memorialId);
    return (
      <form action={saveCoverAction}>
        <input type="hidden" name="memorialId" value={memorialId} />
        {assets.length === 0 ? (
          <p className={styles.hint}>
            No photographs have been approved yet. You can come back to this once a few have arrived
            — the rest of the program does not wait on it.
          </p>
        ) : (
          <ul className={styles.covers}>
            {assets.map((asset) => (
              <li key={asset.id}>
                <button
                  type="submit"
                  name="assetId"
                  value={asset.id}
                  className={`${styles.cover} ${
                    doc.coverAssetId === asset.id ? styles.coverOn : ''
                  }`}
                  aria-pressed={doc.coverAssetId === asset.id}
                >
                  <img
                    className={styles.coverImage}
                    src={`/api/assets/${asset.id}?variant=thumb320`}
                    alt={asset.caption ?? 'A photograph'}
                    loading="lazy"
                  />
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className={styles.hint}>
          The cover crops to a portrait shape, like a framed photograph. Whichever you choose, you
          can change it later.
        </p>
        <button type="submit" name="assetId" value="" className={stepStyles.quiet}>
          {doc.coverAssetId ? 'Use no photograph' : 'Skip for now'}
        </button>
      </form>
    );
  }

  if (stepValue === 'order') {
    return (
      <div>
        <ol className={styles.order}>
          {doc.orderOfService.map((entry, index) => (
            <li key={`${entry.item}-${index}`} className={styles.orderRow}>
              <span className={styles.orderItem}>
                {entry.item}
                {entry.note ? <span className={styles.orderNote}>{entry.note}</span> : null}
              </span>
              <span className={styles.orderButtons}>
                <OrderButton memorialId={memorialId} op="up" index={index} label="Up" />
                <OrderButton memorialId={memorialId} op="down" index={index} label="Down" />
                <OrderButton memorialId={memorialId} op="remove" index={index} label="Remove" />
              </span>
              {/* Renaming is folded away: most lines are right as they are, and
                  an open text box beside every one of fifteen items is a wall. */}
              <details className={styles.rename}>
                <summary className={styles.renameSummary}>Change the wording</summary>
                <form action={orderItemAction} className={styles.renameForm}>
                  <input type="hidden" name="memorialId" value={memorialId} />
                  <input type="hidden" name="op" value="rename" />
                  <input type="hidden" name="index" value={String(index)} />
                  <input
                    className={styles.input}
                    name="item"
                    defaultValue={entry.item}
                    aria-label="What it is called"
                  />
                  <input
                    className={styles.input}
                    name="note"
                    defaultValue={entry.note ?? ''}
                    placeholder="Who is doing it, if you like"
                    aria-label="Who is doing it"
                  />
                  <button type="submit" className={styles.smallButton}>
                    Save the wording
                  </button>
                </form>
              </details>
            </li>
          ))}
        </ol>

        <form action={orderItemAction} className={styles.addRow}>
          <input type="hidden" name="memorialId" value={memorialId} />
          <input type="hidden" name="op" value="add" />
          <label className={styles.field}>
            <span className={styles.label}>Add something</span>
            <input className={styles.input} name="item" placeholder="A poem, read by Nell" />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>And who is doing it, if you like</span>
            <input className={styles.input} name="note" placeholder="Her granddaughter" />
          </label>
          <button type="submit" className={stepStyles.quiet}>
            Add it to the order
          </button>
        </form>
      </div>
    );
  }

  if (stepValue === 'sketch') {
    return (
      <SketchEditor
        memorialId={memorialId}
        text={doc.lifeSketch}
        version={doc.lifeSketch.length}
        fitNote={sketchFitNote(doc.lifeSketch)}
      />
    );
  }

  if (stepValue === 'reading') {
    const suggestions = readingSuggestions(memorial.traditionSlug);
    return (
      <div>
        {doc.reading ? (
          <p className={styles.hint}>
            Chosen: <strong>{doc.reading.title}</strong>. Pick another to change it.
          </p>
        ) : null}

        <ul className={styles.readings}>
          {suggestions.map((reading, index) => (
            <li key={reading.title}>
              <form action={saveReadingAction}>
                <input type="hidden" name="memorialId" value={memorialId} />
                <button
                  type="submit"
                  name="choice"
                  value={String(index)}
                  className={`${styles.reading} ${
                    doc.reading?.title === reading.title ? styles.readingOn : ''
                  }`}
                >
                  <span className={styles.readingTitle}>{reading.title}</span>
                  {reading.text ? (
                    <span className={styles.readingText}>{firstLines(reading.text)}</span>
                  ) : (
                    <span className={styles.readingText}>
                      We can name it in the program, but not print the words — ask whoever is
                      leading for the text they use.
                    </span>
                  )}
                  <span className={styles.readingSource}>{reading.source}</span>
                </button>
              </form>
            </li>
          ))}
        </ul>

        <form action={saveReadingAction} className={styles.ownReading}>
          <input type="hidden" name="memorialId" value={memorialId} />
          <input type="hidden" name="choice" value="own" />
          <h2 className={styles.sectionTitle}>Or paste your own</h2>
          <label className={styles.field}>
            <span className={styles.label}>What it is called</span>
            <input className={styles.input} name="title" placeholder="Her favourite verse" />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>The words</span>
            <textarea className={styles.textarea} name="text" rows={6} />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Where it comes from</span>
            <input
              className={styles.input}
              name="source"
              placeholder="Whoever wrote it, and where you found it"
            />
          </label>
          <p className={styles.hint}>
            If it is a song lyric or a modern poem, printing the whole thing may need permission.
            Naming it, with the author, always works.
          </p>
          <button type="submit" className={stepStyles.quiet}>
            Use this one
          </button>
        </form>

        <form action={saveReadingAction}>
          <input type="hidden" name="memorialId" value={memorialId} />
          <button type="submit" name="choice" value="none" className={stepStyles.quiet}>
            No reading, thank you
          </button>
        </form>
      </div>
    );
  }

  return (
    <form action={saveThanksAction}>
      <input type="hidden" name="memorialId" value={memorialId} />
      <label className={styles.field}>
        <span className={styles.label}>The acknowledgement</span>
        <textarea
          className={styles.textarea}
          name="acknowledgments"
          rows={6}
          defaultValue={doc.acknowledgments}
        />
      </label>
      <label className={styles.field}>
        <span className={styles.label}>Anything else for the back page</span>
        <textarea
          className={styles.textarea}
          name="backNote"
          rows={3}
          defaultValue={doc.backNote}
        />
      </label>
      <button type="submit" className={stepStyles.primary}>
        Save and see the program
      </button>
    </form>
  );
}

function OrderButton({
  memorialId,
  op,
  index,
  label,
}: {
  memorialId: string;
  op: 'up' | 'down' | 'remove';
  index: number;
  label: string;
}) {
  return (
    <form action={orderItemAction} className={styles.inlineForm}>
      <input type="hidden" name="memorialId" value={memorialId} />
      <input type="hidden" name="op" value={op} />
      <input type="hidden" name="index" value={String(index)} />
      <button type="submit" className={styles.smallButton}>
        {label}
      </button>
    </form>
  );
}

function firstLines(text: string, lines = 2): string {
  const parts = text.split('\n').filter((line) => line.trim().length > 0);
  const head = parts.slice(0, lines).join(' ');
  return head.length > 160 ? `${head.slice(0, 160)}…` : head;
}
