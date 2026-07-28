/**
 * Their song, played in the room.
 *
 * We ask for three things and only the first is required: what the song is, who
 * it is by, and — if they can manage it — the tempo, tapped along to whatever is
 * playing on their phone. The tempo is the difference between slides that
 * change with the music and slides that change near it, and it is genuinely
 * optional: a family who does not want to tap still gets a video.
 *
 * Nothing about the recording itself is uploaded, stored or analysed. That is
 * exactly why this mode exists.
 */
import Link from 'next/link';
import { latestProject, musicChoice } from '@col/core';
import { StepScreen, step } from '@/components/StepScreen';
import { db } from '@/server/db';
import { requireOrganizer } from '@/server/auth';
import { TapTempo } from '../TapTempo';
import { chooseSideloadedAction } from '../actions';
import styles from '../music.module.css';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Their song' };

export default async function TheirSongPage({
  params,
  searchParams,
}: {
  params: Promise<{ memorialId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { memorialId } = await params;
  const query = (await searchParams) ?? {};
  const { memorial } = await requireOrganizer(memorialId);

  const choice = musicChoice(db(), latestProject(db(), memorialId));
  const selection = choice.mode === 'sideloaded' ? choice.selection : undefined;

  return (
    <StepScreen
      eyebrow={`Remembering ${memorial.decedentName}`}
      title="Which song will the room hear?"
      helper="The video will be silent and paced to this song. Someone plays it out loud while the video runs."
      secondary={
        <>
          <Link href={`/m/${memorialId}/music/included`}>Use music we include instead</Link>
          <Link href={`/m/${memorialId}/music`}>Back a step</Link>
        </>
      }
      footer="We never receive the recording. We only write the song's name on the card the venue gets."
    >
      {query['problem'] === 'no-title' ? (
        <p className={styles.problem}>
          The song needs a name, so the venue knows what to play. Anything they will recognise is
          fine.
        </p>
      ) : null}

      <form action={chooseSideloadedAction} className={styles.form}>
        <input type="hidden" name="memorialId" value={memorialId} />

        <div>
          <label className={styles.label} htmlFor="title">
            The song
          </label>
          <input
            id="title"
            name="title"
            type="text"
            className={styles.input}
            maxLength={200}
            required
            defaultValue={selection?.sideloadedTitle ?? ''}
            placeholder="Danny Boy"
          />
        </div>

        <div>
          <label className={styles.label} htmlFor="artist">
            Whose version, if it matters
          </label>
          <input
            id="artist"
            name="artist"
            type="text"
            className={styles.input}
            maxLength={200}
            defaultValue={selection?.sideloadedArtist ?? ''}
            placeholder="The one from the kitchen radio"
          />
          <p className={styles.hint}>
            Optional. It helps whoever is pressing play find the right recording.
          </p>
        </div>

        <div>
          <span className={styles.label}>The tempo, if you can</span>
          <TapTempo />
          <p className={styles.hint}>
            Optional. If you tap it, the slides will change with the music instead of near it.
          </p>
        </div>

        <div>
          <label className={styles.label} htmlFor="songSec">
            How long is the song?
          </label>
          <input
            id="songSec"
            name="songSec"
            type="number"
            inputMode="numeric"
            min={30}
            max={1800}
            step={5}
            className={styles.input}
            placeholder="240"
          />
          <p className={styles.hint}>
            In seconds, roughly. Only used to work out where the music turns over.
          </p>
        </div>

        <div>
          <button type="submit" className={step.primary}>
            Time the video to this song
          </button>
        </div>
      </form>
    </StepScreen>
  );
}
