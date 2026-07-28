/**
 * Choosing a piece of music.
 *
 * Ordered rather than filtered: the tradition's own guidance and the mood, if
 * one was picked, decide what comes first, and nothing ever disappears. A list
 * that empties itself when a tired person taps something is a list that makes
 * them think they broke it.
 *
 * Every card can be listened to for fifteen seconds, on purpose, one at a time.
 * Nothing plays on its own.
 */
import Link from 'next/link';
import type { MoodTag } from '@col/schemas';
import {
  MOODS,
  MOOD_LABELS,
  bundledTracks,
  describeTrackLength,
  familyTracks,
  latestProject,
  musicChoice,
  rankTracks,
} from '@col/core';
import { StepScreen, step } from '@/components/StepScreen';
import { db } from '@/server/db';
import { requireOrganizer } from '@/server/auth';
import { TrackPreview } from '../TrackPreview';
import { chooseTrackAction } from '../actions';
import styles from '../music.module.css';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Choose music' };

export default async function IncludedMusicPage({
  params,
  searchParams,
}: {
  params: Promise<{ memorialId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { memorialId } = await params;
  const query = (await searchParams) ?? {};
  const { memorial } = await requireOrganizer(memorialId);

  const mood = MOODS.includes(query['mood'] as MoodTag) ? (query['mood'] as MoodTag) : undefined;
  const project = latestProject(db(), memorialId);
  const choice = musicChoice(db(), project);

  const library = [...bundledTracks(db()), ...familyTracks(db(), memorialId)];
  const ranked = rankTracks(library, {
    traditionSlug: memorial.traditionSlug,
    ...(mood ? { mood } : {}),
  });

  return (
    <StepScreen
      wide
      eyebrow={`Remembering ${memorial.decedentName}`}
      title="Which piece of music?"
      helper="Listen to a few. Fifteen seconds is usually enough to know."
      secondary={
        <>
          <Link href={`/m/${memorialId}/music/upload`}>Use a recording of our own</Link>
          <Link href={`/m/${memorialId}/music`}>
            The other way — their song, played in the room
          </Link>
        </>
      }
      footer="Whichever you choose, the video can be shared anywhere: these pieces were written for this toolkit and belong to nobody."
    >
      {query['problem'] === 'unknown-track' ? (
        <p className={styles.problem}>That piece is not available. Everything below is.</p>
      ) : null}

      {library.length === 0 ? (
        <p className={styles.problem}>
          The music library has not been loaded yet. Run <code>pnpm music:build</code> and then{' '}
          <code>pnpm music:seed</code>, or start the worker — it loads the library at boot.
        </p>
      ) : null}

      <nav className={styles.moods} aria-label="Narrow by feeling">
        <Link
          href={`/m/${memorialId}/music/included`}
          className={`${styles.mood} ${mood ? '' : styles.moodActive}`}
        >
          Everything
        </Link>
        {MOODS.map((tag) => (
          <Link
            key={tag}
            href={`/m/${memorialId}/music/included?mood=${tag}`}
            className={`${styles.mood} ${mood === tag ? styles.moodActive : ''}`}
          >
            {MOOD_LABELS[tag]}
          </Link>
        ))}
      </nav>

      <p className={styles.previewNote}>Nothing plays until you press Listen.</p>

      <ul className={styles.tracks}>
        {ranked.map(({ track, why }) => {
          const chosen = choice.track?.id === track.id;
          return (
            <li key={track.id} className={`${styles.track} ${chosen ? styles.trackChosen : ''}`}>
              <div className={styles.trackBody}>
                <p className={styles.trackTitle}>{track.title}</p>
                <p className={styles.trackMeta}>
                  {[
                    describeTrackLength(track.durationSec),
                    (track.moodTags ?? [])
                      .map((tag) => MOOD_LABELS[tag as MoodTag] ?? tag)
                      .join(' · '),
                    track.licenseKind === 'family-supplied' ? 'Your own recording' : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                {why && !chosen ? <p className={styles.trackWhy}>{why}</p> : null}
              </div>

              <div className={styles.trackActions}>
                <TrackPreview src={`/api/music/${track.id}`} title={track.title} />
                {chosen ? (
                  <span className={styles.chosenBadge}>Chosen</span>
                ) : (
                  <form action={chooseTrackAction}>
                    <input type="hidden" name="memorialId" value={memorialId} />
                    <input type="hidden" name="trackId" value={track.id} />
                    <button type="submit" className={styles.choose}>
                      Use this one
                    </button>
                  </form>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {choice.decided && choice.mode === 'cleared' ? (
        <p className={styles.afterChoice}>
          <Link className={step.quiet} href={`/m/${memorialId}/preview`}>
            Watch the slideshow with this music
          </Link>
        </p>
      ) : null}

      <p className={styles.licence}>
        Every piece here was generated for this project and released into the public domain (CC0).
        There is no attribution to give and no licence fee to pay — the provenance for each one is
        in <code>content/music-library</code>, next to the audio.
      </p>
    </StepScreen>
  );
}
