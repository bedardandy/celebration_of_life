/**
 * A recording that belongs to the family.
 *
 * Grandpa at the piano. The choir your mother sang in. A voicemail somebody
 * kept. These are often the best possible soundtrack and are usually free of
 * anyone else's rights — but we cannot know that, so we ask, once, in one
 * sentence, and write down what was agreed to and when.
 *
 * We work out the tempo from the recording so the slides can be cut to it. That
 * happens on this machine; nothing is sent anywhere.
 */
import Link from 'next/link';
import { OWNERSHIP_STATEMENT } from '@col/core';
import { StepScreen, step } from '@/components/StepScreen';
import { requireOrganizer } from '@/server/auth';
import { uploadOwnAudioAction } from '../actions';
import styles from '../music.module.css';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Use our own recording' };

const PROBLEMS: Record<string, string> = {
  'no-file': 'No file arrived. It may be worth trying again — some phones are slow to attach.',
  'not-confirmed':
    'We need the box ticked before we can put a recording into a video you will share.',
  unreadable:
    'We could not read that as audio. MP3, M4A, WAV and FLAC all work; a video file will not.',
};

export default async function UploadMusicPage({
  params,
  searchParams,
}: {
  params: Promise<{ memorialId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { memorialId } = await params;
  const query = (await searchParams) ?? {};
  const { memorial } = await requireOrganizer(memorialId);
  const problem = PROBLEMS[String(query['problem'] ?? '')];

  return (
    <StepScreen
      eyebrow={`Remembering ${memorial.decedentName}`}
      title="Use a recording of your own"
      helper="Something your family owns — someone playing, someone singing, a recording you have the right to use."
      secondary={
        <>
          <Link href={`/m/${memorialId}/music/included`}>Use music we include instead</Link>
          <Link href={`/m/${memorialId}/music`}>Back a step</Link>
        </>
      }
      footer="The file stays on this machine. Deleting the memorial deletes it, properly."
    >
      {problem ? <p className={styles.problem}>{problem}</p> : null}

      <form action={uploadOwnAudioAction} className={styles.form} encType="multipart/form-data">
        <input type="hidden" name="memorialId" value={memorialId} />

        <div>
          <label className={styles.label} htmlFor="audio">
            The recording
          </label>
          <input
            id="audio"
            name="audio"
            type="file"
            accept="audio/*,.mp3,.m4a,.wav,.flac,.aac,.ogg"
            className={styles.input}
            required
          />
          <p className={styles.hint}>MP3, M4A, WAV or FLAC. Anything up to about ten minutes.</p>
        </div>

        <div>
          <label className={styles.label} htmlFor="title">
            What should we call it?
          </label>
          <input
            id="title"
            name="title"
            type="text"
            className={styles.input}
            maxLength={120}
            placeholder="Dad playing the piano, 1997"
          />
        </div>

        <label className={styles.checkbox}>
          <input type="checkbox" name="owned" value="yes" />
          <span>{OWNERSHIP_STATEMENT}</span>
        </label>

        <p className={styles.hint}>
          We ask because this recording goes inside a video you may share widely. A commercial song
          copied from a streaming service is not covered by that sentence — for those, the other way
          round works better:{' '}
          <Link className={step.quiet} href={`/m/${memorialId}/music/their-song`}>
            keep the video silent and have the room play the song
          </Link>
          .
        </p>

        <div>
          <button type="submit" className={step.primary}>
            Use this recording
          </button>
        </div>
      </form>
    </StepScreen>
  );
}
