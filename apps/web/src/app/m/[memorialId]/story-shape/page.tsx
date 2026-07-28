/**
 * One decision: what shape should this take?
 *
 * The recommendation is computed from the photographs the family actually has,
 * not offered as a menu of equals — a screen that says "choose an information
 * architecture" to someone four days after a death is a screen that gets
 * abandoned. So: one recommended card with a button, one line saying why, and
 * the other two underneath, quieter, still there for anyone who disagrees.
 */
import Link from 'next/link';
import {
  approvedAssets,
  latestProject,
  recommendStructure,
  type StructureOption,
} from '@col/core';
import { StepScreen, step } from '@/components/StepScreen';
import { db } from '@/server/db';
import { requireOrganizer } from '@/server/auth';
import { chooseShapeAction } from './actions';
import styles from './story-shape.module.css';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'The shape of their story' };

export default async function StoryShapePage({
  params,
}: {
  params: Promise<{ memorialId: string }>;
}) {
  const { memorialId } = await params;
  const { memorial } = await requireOrganizer(memorialId);

  const assets = approvedAssets(db(), memorialId);
  const recommendation = recommendStructure({
    eras: assets.map((asset) => asset.eraGuess ?? asset.analysis?.eraGuess ?? null),
  });
  const [recommended, ...alternatives] = recommendation.options;
  const project = latestProject(db(), memorialId);
  const alreadyBuilt = Boolean(project?.edl);

  if (assets.length === 0) {
    return (
      <StepScreen
        eyebrow={`Remembering ${memorial.decedentName}`}
        title="No photos chosen yet"
        helper="Pick the ones you want in the slideshow and this page will have something to arrange."
        primary={
          <Link className={step.primary} href={`/m/${memorialId}/curate`}>
            Go through the photos
          </Link>
        }
        secondary={<Link href={`/m/${memorialId}`}>Back to the dashboard</Link>}
      />
    );
  }

  return (
    <StepScreen
      eyebrow={`Remembering ${memorial.decedentName}`}
      title="How should their story run?"
      helper={`${assets.length} ${assets.length === 1 ? 'photo' : 'photos'} to work with. You can change this later.`}
      primary={
        recommended ? (
          <form action={chooseShapeAction}>
            <input type="hidden" name="memorialId" value={memorialId} />
            <input type="hidden" name="structure" value={recommended.id} />
            <button type="submit" className={step.primary}>
              {alreadyBuilt ? 'Rebuild it this way' : `Yes — ${recommended.title.toLowerCase()}`}
            </button>
          </form>
        ) : null
      }
      secondary={<Link href={`/m/${memorialId}`}>Back to the dashboard</Link>}
      footer="Putting it together takes a minute or two. You do not have to watch."
    >
      {recommended ? (
        <section className={styles.recommended}>
          <p className={styles.badge}>Suggested</p>
          <h2 className={styles.title}>{recommended.title}</h2>
          <p className={styles.blurb}>{recommended.blurb}</p>
          <p className={styles.why}>{recommendation.why}</p>
        </section>
      ) : null}

      <div className={styles.alternatives}>
        {alternatives.map((option) => (
          <Alternative key={option.id} memorialId={memorialId} option={option} />
        ))}
      </div>
    </StepScreen>
  );
}

function Alternative({ memorialId, option }: { memorialId: string; option: StructureOption }) {
  return (
    <form action={chooseShapeAction} className={styles.alternative}>
      <input type="hidden" name="memorialId" value={memorialId} />
      <input type="hidden" name="structure" value={option.id} />
      <h3 className={styles.altTitle}>{option.title}</h3>
      <p className={styles.altBlurb}>{option.blurb}</p>
      <button type="submit" className={step.quiet}>
        Do it this way instead
      </button>
    </form>
  );
}
