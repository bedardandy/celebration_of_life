/**
 * The two pieces of paper.
 *
 * Almost everything else in this product happens on a screen. These two do not:
 * they get printed, or written out by hand from a phone, and handed to somebody
 * at a venue who has never met this family and has forty minutes to get it
 * right. So they are short, they are specific, and they say the file name out
 * loud.
 *
 *  - the funeral-director card: what the file is called, how long it runs, what
 *    format it is, and "please test it before the service";
 *  - the venue timing card (side-loaded mode only): which song, when to start
 *    it, and what happens if it drifts.
 *
 * Both are produced as structured data here and rendered as printable HTML by
 * the web app, so the same words can also be copied into an email or read down
 * a telephone.
 */
import type { CutName, RenderPreset } from '@col/schemas';
import { describeLength } from '../edl/timing';
import { deliverableFilename } from './filenames';

export type DirectorCardInput = {
  decedentName: string;
  cut: CutName;
  preset: RenderPreset;
  /** From the verified file, not from the plan. */
  durationSec: number;
  width?: number;
  height?: number;
  /** 'cleared' means the sound is in the file; 'sideloaded' means it is not. */
  audioMode: 'cleared' | 'sideloaded';
  /** The tradition pack's placement note, in the pack's own words. */
  placementNote?: { context: string; guidance: string };
  serviceDateLabel?: string;
  organizerName?: string;
  organizerContact?: string;
};

export type CardLine = { label: string; value: string };

export type DirectorCard = {
  title: string;
  filename: string;
  lines: CardLine[];
  /** Heading above the checklist, so the text version reads like the page. */
  checklistTitle: string;
  /** Things to do, in order, on the day. */
  checklist: string[];
  /** The one sentence that matters most, set apart. */
  emphasis: string;
  placementNote?: { context: string; guidance: string };
};

export function buildDirectorCard(input: DirectorCardInput): DirectorCard {
  const filename = deliverableFilename({
    decedentName: input.decedentName,
    cut: input.cut,
    preset: input.preset,
  });

  const lines: CardLine[] = [
    { label: 'File name', value: filename },
    { label: 'Length', value: describeLength(input.durationSec) },
    {
      label: 'Format',
      value:
        input.width && input.height
          ? `MP4 · H.264 video · AAC audio · ${input.width}×${input.height} · 30 fps`
          : 'MP4 · H.264 video · AAC audio · 30 fps',
    },
    {
      label: 'Sound',
      value:
        input.audioMode === 'cleared'
          ? 'The music is in the file. Play it through the room’s speakers.'
          : 'The video is SILENT on purpose. The song is played separately — see the timing card.',
    },
  ];

  if (input.serviceDateLabel) lines.push({ label: 'Service', value: input.serviceDateLabel });
  if (input.organizerName) {
    lines.push({
      label: 'Family contact',
      value: input.organizerContact
        ? `${input.organizerName} · ${input.organizerContact}`
        : input.organizerName,
    });
  }

  return {
    title: `${input.decedentName} — tribute video`,
    filename,
    lines,
    emphasis:
      'Please play the file all the way through on the venue’s own equipment before the service.',
    checklistTitle: 'Before the service',
    checklist: [
      'Copy the file to the machine that will play it, or plug in the USB stick and open it from there.',
      'Play the first thirty seconds and the last thirty seconds with the sound up.',
      input.audioMode === 'cleared'
        ? 'Check the volume against something else you play in that room.'
        : 'Check that the video is silent, and that whoever plays the song has it ready.',
      'Set the player to stop at the end, not to autoplay something else.',
    ],
    ...(input.placementNote ? { placementNote: input.placementNote } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* the venue timing card                                                       */
/* -------------------------------------------------------------------------- */

export type TimingCardInput = {
  decedentName: string;
  songTitle: string;
  songArtist?: string;
  /** The video's length, from the verified render or the timeline. */
  durationSec: number;
  /** Seconds of black at the top of the video, which is the operator's cue. */
  openingFadeSec?: number;
  bpm?: number | null;
};

export type TimingCard = {
  title: string;
  song: string;
  lines: CardLine[];
  checklistTitle: string;
  checklist: string[];
  emphasis: string;
};

/** Seconds of held black the composition opens on. Kept in step with @col/video. */
export const OPENING_FADE_SEC = 1;

/**
 * How to run a silent video and a live song together.
 *
 * The cue is deliberately the thing the operator can *see* — the screen coming
 * up out of black — rather than a count or a clock, because the person pressing
 * play is watching the room, not a stopwatch. And the last line is permission
 * to be imperfect: a song that ends a few seconds after the screen does is
 * completely fine, and telling someone that in advance stops them panicking at
 * the back of a chapel.
 */
export function buildTimingCard(input: TimingCardInput): TimingCard {
  const song = [input.songTitle, input.songArtist].filter(Boolean).join(' — ');
  const fade = input.openingFadeSec ?? OPENING_FADE_SEC;

  const lines: CardLine[] = [
    { label: 'Song', value: song || 'The song the family chose' },
    { label: 'Video length', value: describeLength(input.durationSec) },
    { label: 'Start the song', value: 'When the screen fades up from black — about a second in.' },
    { label: 'The video has no sound', value: 'That is deliberate. Nothing is broken.' },
  ];
  if (input.bpm) {
    lines.push({
      label: 'Timing',
      value: `The slides were paced to about ${Math.round(input.bpm)} beats a minute, so changes fall with the music.`,
    });
  }

  return {
    title: `${input.decedentName} — playing the song with the video`,
    song: song || 'The song the family chose',
    lines,
    emphasis: `Start the song as the first picture appears. Video runs ${describeLength(input.durationSec)}.`,
    checklistTitle: 'On the day',
    checklist: [
      'Have the song cued up and the volume set before people come in.',
      `Start the video. Wait ${fade === 1 ? 'about a second' : `about ${fade} seconds`} for the screen to come up from black.`,
      'Start the song as the first picture appears.',
      'Let the song finish, even if the screen goes dark first. A few seconds either way is fine and nobody will notice.',
    ],
  };
}

/**
 * The same card as plain text.
 *
 * For pasting into an email to the funeral home, or reading down a telephone.
 * Not a fallback for a rendering failure: some people simply want the words.
 */
export function cardToText(card: DirectorCard | TimingCard): string {
  const out: string[] = [card.title, '='.repeat(Math.min(card.title.length, 60)), ''];
  for (const line of card.lines) out.push(`${line.label}: ${line.value}`);
  out.push('', card.emphasis, '');
  out.push(`${card.checklistTitle}:`);
  for (const [index, item] of card.checklist.entries()) out.push(`  ${index + 1}. ${item}`);
  if ('placementNote' in card && card.placementNote) {
    out.push('', `${card.placementNote.context}`, card.placementNote.guidance);
  }
  return out.join('\n');
}

/* -------------------------------------------------------------------------- */
/* the USB note                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Getting the file onto a stick, for someone who has never formatted anything.
 *
 * FAT32 because it is the one format every venue player, smart TV and DVD deck
 * agrees on; the four-gigabyte limit is not a problem for a five-minute H.264
 * file and is worth the compatibility. The advice about the root of the stick
 * sounds fussy and is not: plenty of players will not open a folder.
 */
export const USB_STEPS: readonly string[] = [
  'Use an ordinary USB stick, 8 GB or larger. A new one is safer than one with holiday photos on it.',
  'Format it as FAT32 if you can — that is the format almost every venue player understands. exFAT is the next best.',
  'Copy the video file to the top level of the stick, not inside a folder. Some players will not look inside folders.',
  'Do not rename the file. The funeral director’s card names it exactly as it is.',
  'Eject the stick properly before you pull it out, or the file may be incomplete.',
  'Take a second stick if you have one, and email the file to the funeral director as well. Two copies, two ways.',
];
