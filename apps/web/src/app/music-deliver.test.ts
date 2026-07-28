/**
 * The last two screens, headless.
 *
 * An organiser decides how the music works, picks something, watches the
 * slideshow re-time itself around it, asks for a video, waits, and downloads a
 * file with their mother's name on it. Everything here runs the real server
 * actions, the real pages and the real authorised routes — no browser, no
 * queue, and no rendering, because what is being tested is the journey and the
 * gates on it, not ffmpeg.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

const workdir = mkdtempSync(path.join(tmpdir(), 'col-music-test-'));
process.env['DATABASE_URL'] = `file:${path.join(workdir, 'music.db')}`;
process.env['STORAGE_DIR'] = path.join(workdir, 'blobs');
process.env['SESSION_SECRET'] = 'music-test-secret';
process.env['APP_BASE_URL'] = 'http://localhost:3000';

vi.mock('next/headers', async () => {
  const { nextHeadersMock } = await import('@/test/next-stubs');
  return nextHeadersMock();
});
vi.mock('next/cache', async () => {
  const { nextCacheMock } = await import('@/test/next-stubs');
  return nextCacheMock();
});

const { cookieJar, captureRedirect } = await import('@/test/next-stubs');
const { db } = await import('@/server/db');
const { createMemorialAction } = await import('./new/actions');
const { chooseShapeAction } = await import('./m/[memorialId]/story-shape/actions');
const { chooseModeAction, chooseTrackAction, chooseSideloadedAction, uploadOwnAudioAction } =
  await import('./m/[memorialId]/music/actions');
const { startRenderAction } = await import('./m/[memorialId]/deliver/actions');
const MusicPage = (await import('./m/[memorialId]/music/page')).default;
const IncludedPage = (await import('./m/[memorialId]/music/included/page')).default;
const TheirSongPage = (await import('./m/[memorialId]/music/their-song/page')).default;
const ChosenPage = (await import('./m/[memorialId]/music/chosen/page')).default;
const DeliverPage = (await import('./m/[memorialId]/deliver/page')).default;
const DirectorCardPage = (await import('./m/[memorialId]/deliver/card/page')).default;
const TimingCardPage = (await import('./m/[memorialId]/deliver/timing-card/page')).default;
const PreviewPage = (await import('./m/[memorialId]/preview/page')).default;
const DashboardPage = (await import('./m/[memorialId]/page')).default;
const { GET: downloadRender } = await import('./api/renders/[renderJobId]/route');
const { GET: getMusic } = await import('./api/music/[trackId]/route');
const { GET: getCardText } = await import('./api/deliver/[memorialId]/card.txt/route');

const {
  DevConsoleTransport,
  buildContext,
  bundledTracks,
  currentSelection,
  generateEdl,
  latestProject,
  projectEdl,
  saveEdl,
  seedMusicLibrary,
  setMailTransport,
} = await import('@col/core');
const { insertOne, listWhere, mediaAssets, memoryNotes, musicTracks, renderJobs, updateById } =
  await import('@col/db');
const { encodeWav } = await import('@col/media');
const { getBlobStore } = await import('@col/storage');
const { resetMockState } = await import('@col/ai');

beforeAll(async () => {
  setMailTransport(new DevConsoleTransport(() => {}));
  db();
  await seedMusicLibrary(db(), getBlobStore());
});

afterAll(() => {
  setMailTransport(undefined);
  rmSync(workdir, { recursive: true, force: true });
});

beforeEach(() => {
  cookieJar.clear();
  resetMockState();
});

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

async function signedInMemorial(): Promise<string> {
  const destination = await captureRedirect(() =>
    createMemorialAction(
      {},
      form({
        decedentName: 'Ruth Kelleher',
        organizerName: 'Anne Doyle',
        organizerEmail: `anne+${Math.random().toString(36).slice(2)}@example.test`,
      }),
    ),
  );
  return destination.split('/')[2] as string;
}

function addApprovedPhoto(memorialId: string, index: number, year: number): string {
  const asset = insertOne(db(), mediaAssets, {
    memorialId,
    originalFilename: `photo-${index}.jpg`,
    mime: 'image/jpeg',
    blobKey: `memorial/${memorialId}/original/photo-${index}.jpg`,
    curationState: 'approved',
    ingestState: 'ready',
    capturedAt: Date.UTC(year, 3, 1),
    eraGuess: `${Math.floor(year / 10) * 10}s`,
    width: 4000,
    height: 3000,
    analysis: {
      description: `A photograph from ${year}`,
      settingTags: ['home'],
      emotionalTone: 'warm',
      slideSuitability: Number((0.3 + (index % 6) * 0.1).toFixed(2)),
    },
  } as never) as { id: string };
  return asset.id;
}

/** A memorial with a generated slideshow, ready for the music screens. */
async function memorialWithSlideshow(): Promise<string> {
  const memorialId = await signedInMemorial();
  for (let i = 0; i < 12; i += 1) addApprovedPhoto(memorialId, i, 1950 + i * 6);
  insertOne(db(), memoryNotes, {
    memorialId,
    authorName: 'Her daughter, Anne',
    text: 'She always said the garden would outlive her.',
    approved: true,
  } as never);

  await captureRedirect(() => chooseShapeAction(form({ memorialId, structure: 'chrono' })));
  const project = latestProject(db(), memorialId);
  if (!project) throw new Error('no slideshow project');
  const result = await generateEdl(buildContext(db(), memorialId, project.id));
  saveEdl(db(), project.id, result.edl, { status: 'ready' });
  return memorialId;
}

/* -------------------------------------------------------------------------- */
/* rendering server components without a browser                               */
/* -------------------------------------------------------------------------- */

type Node = ReactElement | string | number | null | undefined | boolean | Node[];

function isElement(node: unknown): node is ReactElement {
  return typeof node === 'object' && node !== null && 'props' in node && 'type' in node;
}

const NOT_TEXT = new Set([
  'className',
  'style',
  'src',
  'id',
  'key',
  'type',
  'name',
  'action',
  'width',
  'height',
  'loading',
  'htmlFor',
]);

const CLIENT_COMPONENTS = new Set([
  'PreviewPlayer',
  'CaptionField',
  'WaitingRefresh',
  'SavedIndicator',
  'RemoveMemorial',
  'RenderWatch',
  'TrackPreview',
  'TapTempo',
]);

/** Every string of text a server component put on the page, props included. */
function textOf(node: Node): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (!isElement(node)) return '';

  const props = node.props as Record<string, unknown>;
  const type = node.type as unknown;
  if (typeof type === 'function') {
    const name =
      (type as { displayName?: string; name?: string }).displayName ??
      (type as { name?: string }).name ??
      '';
    if (!CLIENT_COMPONENTS.has(name)) {
      try {
        const rendered = (type as (p: unknown) => unknown)(props);
        if (!(rendered instanceof Promise)) return textOf(rendered as Node);
      } catch {
        // A component that needs a browser contributes nothing, honestly.
      }
    }
  }

  return Object.entries(props)
    .filter(([key]) => !NOT_TEXT.has(key))
    .map(([, value]) => textOf(value as Node))
    .join(' ');
}

/** Every href on a page, for checking where a screen leads. */
function hrefsOf(node: Node, found: string[] = []): string[] {
  if (node == null || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    for (const child of node) hrefsOf(child, found);
    return found;
  }
  if (!isElement(node)) return found;
  const props = node.props as Record<string, unknown>;
  if (typeof props['href'] === 'string') found.push(props['href']);

  const type = node.type as unknown;
  if (typeof type === 'function') {
    const name =
      (type as { displayName?: string; name?: string }).displayName ??
      (type as { name?: string }).name ??
      '';
    if (!CLIENT_COMPONENTS.has(name)) {
      try {
        const rendered = (type as (p: unknown) => unknown)(props);
        if (!(rendered instanceof Promise)) hrefsOf(rendered as Node, found);
      } catch {
        /* needs a browser */
      }
    }
  }
  for (const [key, value] of Object.entries(props)) {
    if (key !== 'href') hrefsOf(value as Node, found);
  }
  return found;
}

const params = (memorialId: string) => Promise.resolve({ memorialId });

/** Renders belonging to one memorial: the table is shared across these tests. */
function rendersFor(memorialId: string) {
  return listWhere(db(), renderJobs).filter((row) => row.memorialId === memorialId);
}
const search = (query: Record<string, string> = {}) => Promise.resolve(query);

/* -------------------------------------------------------------------------- */
/* the mode decision                                                           */
/* -------------------------------------------------------------------------- */

describe('the music mode decision', () => {
  it('explains both ways in plain language, with no wall of legalese', async () => {
    const memorialId = await memorialWithSlideshow();
    const text = textOf((await MusicPage({ params: params(memorialId) })) as Node);

    expect(text).toContain('How should the music work?');
    expect(text).toContain('shared anywhere');
    expect(text).toContain('the video itself stays silent');
    expect(text).toContain('played out loud in the room');
    // The honest reason, once, in a sentence — not a licence agreement.
    expect(text).toContain('licence for that song');
    expect(text).not.toMatch(/hereby|indemnif|warrant/i);
  });

  it('shows the tradition’s own words about music', async () => {
    const memorialId = await memorialWithSlideshow();
    const text = textOf((await MusicPage({ params: params(memorialId) })) as Node);
    // Secular pack, verbatim.
    expect(text).toContain('Anything that sounds like them is right');
  });

  it('sends each card to its own screen', async () => {
    const memorialId = await memorialWithSlideshow();
    expect(
      await captureRedirect(() => chooseModeAction(form({ memorialId, mode: 'cleared' }))),
    ).toBe(`/m/${memorialId}/music/included`);
    expect(
      await captureRedirect(() => chooseModeAction(form({ memorialId, mode: 'sideloaded' }))),
    ).toBe(`/m/${memorialId}/music/their-song`);
  });
});

/* -------------------------------------------------------------------------- */
/* the picker                                                                  */
/* -------------------------------------------------------------------------- */

describe('the track picker', () => {
  it('lists the bundled library with lengths, and never autoplays', async () => {
    const memorialId = await memorialWithSlideshow();
    const page = (await IncludedPage({
      params: params(memorialId),
      searchParams: search(),
    })) as Node;
    const text = textOf(page);

    const tracks = bundledTracks(db());
    expect(tracks.length).toBeGreaterThanOrEqual(4);
    for (const track of tracks) expect(text).toContain(track.title);

    expect(text).toContain('Nothing plays until you press Listen');
    expect(text).toContain('public domain');
  });

  it('narrows by mood without hiding anything', async () => {
    const memorialId = await memorialWithSlideshow();
    const page = (await IncludedPage({
      params: params(memorialId),
      searchParams: search({ mood: 'hopeful' }),
    })) as Node;
    const text = textOf(page);
    // Every track is still on the page; only the order changed.
    for (const track of bundledTracks(db())) expect(text).toContain(track.title);
  });

  it('saves the choice, snaps the slideshow to it, and goes forward', async () => {
    const memorialId = await memorialWithSlideshow();
    const track = bundledTracks(db())[0];
    if (!track) throw new Error('no tracks seeded');

    const project = latestProject(db(), memorialId);
    const before = projectEdl(project);
    expect(before?.audio.beatGrid).toBeUndefined();

    const destination = await captureRedirect(() =>
      chooseTrackAction(form({ memorialId, trackId: track.id })),
    );
    expect(destination).toBe(`/m/${memorialId}/music/chosen`);

    const after = latestProject(db(), memorialId);
    const edl = projectEdl(after);
    expect(after?.audioMode).toBe('cleared');
    expect(edl?.audio.trackId).toBe(track.id);
    expect(edl?.audio.beatGrid?.bpm).toBe(track.bpm);
    expect(after?.edlVersion).toBeGreaterThan(project?.edlVersion ?? 0);

    const selection = currentSelection(db(), after?.id ?? '');
    expect(selection?.mode).toBe('cleared');
    expect(selection?.trackId).toBe(track.id);
  });

  it('marks the chosen track when the family comes back to the screen', async () => {
    const memorialId = await memorialWithSlideshow();
    const track = bundledTracks(db())[0];
    if (!track) throw new Error('no tracks seeded');
    await captureRedirect(() => chooseTrackAction(form({ memorialId, trackId: track.id })));

    const text = textOf(
      (await IncludedPage({ params: params(memorialId), searchParams: search() })) as Node,
    );
    expect(text).toContain('Chosen');
  });

  it('turns away a track id that is not real', async () => {
    const memorialId = await memorialWithSlideshow();
    const destination = await captureRedirect(() =>
      chooseTrackAction(form({ memorialId, trackId: 'not-a-track' })),
    );
    expect(destination).toContain('problem=unknown-track');
  });
});

/* -------------------------------------------------------------------------- */
/* their song                                                                  */
/* -------------------------------------------------------------------------- */

describe('timing it to their song', () => {
  it('asks for the song, the artist and — optionally — a tapped tempo', async () => {
    const memorialId = await memorialWithSlideshow();
    const text = textOf(
      (await TheirSongPage({ params: params(memorialId), searchParams: search() })) as Node,
    );
    expect(text).toContain('Which song will the room hear?');
    expect(text).toContain('Optional');
    expect(text).toContain('never receive the recording');
  });

  it('stores the song and builds a grid from the tapped tempo', async () => {
    const memorialId = await memorialWithSlideshow();
    await captureRedirect(() =>
      chooseSideloadedAction(
        form({ memorialId, title: 'Danny Boy', artist: 'Her brother', bpm: '68', songSec: '240' }),
      ),
    );

    const project = latestProject(db(), memorialId);
    const edl = projectEdl(project);
    expect(project?.audioMode).toBe('sideloaded');
    expect(edl?.audio.mode).toBe('sideloaded');
    expect(edl?.audio.beatGrid?.bpm).toBe(68);
    // Nothing of theirs is stored: no track row, no audio.
    expect(edl?.audio.trackId).toBeUndefined();

    const selection = currentSelection(db(), project?.id ?? '');
    expect(selection?.sideloadedTitle).toBe('Danny Boy');
  });

  it('still works when nobody knows the tempo', async () => {
    const memorialId = await memorialWithSlideshow();
    await captureRedirect(() => chooseSideloadedAction(form({ memorialId, title: 'Danny Boy' })));
    const edl = projectEdl(latestProject(db(), memorialId));
    expect(edl?.audio.mode).toBe('sideloaded');
    expect(edl?.audio.beatGrid).toBeUndefined();
  });

  it('asks again, kindly, when the song has no name', async () => {
    const memorialId = await memorialWithSlideshow();
    const destination = await captureRedirect(() =>
      chooseSideloadedAction(form({ memorialId, title: '   ' })),
    );
    expect(destination).toContain('problem=no-title');
  });
});

/* -------------------------------------------------------------------------- */
/* a recording of their own                                                    */
/* -------------------------------------------------------------------------- */

describe('using a recording the family owns', () => {
  /** Four seconds of a quiet two-note figure, as a real WAV file. */
  function ownRecording(): File {
    const sampleRate = 44_100;
    const frames = sampleRate * 4;
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let i = 0; i < frames; i += 1) {
      const t = i / sampleRate;
      // A note every half second, so there is something to find a tempo in.
      const envelope = Math.exp(-(t % 0.5) * 6);
      const value = 0.3 * envelope * Math.sin(2 * Math.PI * (t % 1 < 0.5 ? 220 : 330) * t);
      left[i] = value;
      right[i] = value;
    }
    const wav = encodeWav([left, right], { sampleRate, channels: 2 });
    return new File([new Uint8Array(wav)], 'dad-at-the-piano.wav', { type: 'audio/wav' });
  }

  function uploadForm(memorialId: string, values: Record<string, string>, file?: File): FormData {
    const data = form({ memorialId, ...values });
    if (file) data.append('audio', file);
    return data;
  }

  it('stores it under the memorial, finds a tempo, and records what was agreed', async () => {
    const memorialId = await memorialWithSlideshow();

    const destination = await captureRedirect(() =>
      uploadOwnAudioAction(
        uploadForm(memorialId, { title: 'Dad at the piano, 1997', owned: 'yes' }, ownRecording()),
      ),
    );
    expect(destination).toBe(`/m/${memorialId}/music/chosen`);

    const track = listWhere(db(), musicTracks).find(
      (row) => row.title === 'Dad at the piano, 1997',
    );
    expect(track).toBeDefined();
    expect(track?.licenseKind).toBe('family-supplied');
    // The sentence they ticked, verbatim and dated — not a boolean.
    expect(track?.licenseNote).toContain('belongs to our family');
    expect(track?.licenseNote).toMatch(/\d{4}-\d{2}-\d{2}/);
    // Under this memorial's prefix, so a hard delete really removes it.
    expect(track?.blobKey?.startsWith(`memorial/${memorialId}/music/`)).toBe(true);
    expect(track?.durationSec).toBeGreaterThan(3);
    expect(track?.bpm).toBeGreaterThan(0);
    expect(track?.beatGrid?.phrases.length ?? 0).toBeGreaterThan(0);

    // And it is now the chosen music, with the slideshow timed to it.
    const project = latestProject(db(), memorialId);
    expect(project?.audioMode).toBe('cleared');
    expect(projectEdl(project)?.audio.trackId).toBe(track?.id);
  });

  it('will not take a recording without the one sentence being ticked', async () => {
    const memorialId = await memorialWithSlideshow();
    const destination = await captureRedirect(() =>
      uploadOwnAudioAction(uploadForm(memorialId, { title: 'Untidy' }, ownRecording())),
    );
    expect(destination).toContain('problem=not-confirmed');
    expect(listWhere(db(), musicTracks).some((row) => row.title === 'Untidy')).toBe(false);
  });

  it('says so plainly when the file is not audio, and keeps nothing', async () => {
    const memorialId = await memorialWithSlideshow();
    const notAudio = new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], 'holiday.mp3', {
      type: 'audio/mpeg',
    });

    const destination = await captureRedirect(() =>
      uploadOwnAudioAction(uploadForm(memorialId, { owned: 'yes' }, notAudio)),
    );
    expect(destination).toContain('problem=unreadable');
    expect(listWhere(db(), musicTracks).some((row) => row.blobKey?.includes(memorialId))).toBe(
      false,
    );
  });

  it('asks again when nothing arrived at all', async () => {
    const memorialId = await memorialWithSlideshow();
    const destination = await captureRedirect(() =>
      uploadOwnAudioAction(uploadForm(memorialId, { owned: 'yes' })),
    );
    expect(destination).toContain('problem=no-file');
  });
});

/* -------------------------------------------------------------------------- */
/* what changes elsewhere                                                      */
/* -------------------------------------------------------------------------- */

describe('once the music is chosen', () => {
  it('tells the family the slideshow was re-timed', async () => {
    const memorialId = await memorialWithSlideshow();
    const track = bundledTracks(db())[0];
    if (!track) throw new Error('no tracks');
    await captureRedirect(() => chooseTrackAction(form({ memorialId, trackId: track.id })));

    const page = (await ChosenPage({ params: params(memorialId) })) as Node;
    const text = textOf(page);
    expect(text).toContain('re-timed');
    expect(hrefsOf(page)).toContain(`/m/${memorialId}/deliver`);
  });

  it('changes the preview screen’s one primary action to making the video', async () => {
    const memorialId = await memorialWithSlideshow();

    const before = textOf(
      (await PreviewPage({ params: params(memorialId), searchParams: search() })) as Node,
    );
    expect(before).toContain('choose music next');

    const track = bundledTracks(db())[0];
    if (!track) throw new Error('no tracks');
    await captureRedirect(() => chooseTrackAction(form({ memorialId, trackId: track.id })));

    const page = (await PreviewPage({
      params: params(memorialId),
      searchParams: search(),
    })) as Node;
    expect(textOf(page)).toContain('make the video');
    expect(hrefsOf(page)).toContain(`/m/${memorialId}/deliver`);
  });

  it('moves the dashboard card on to making the video', async () => {
    const memorialId = await memorialWithSlideshow();
    const track = bundledTracks(db())[0];
    if (!track) throw new Error('no tracks');
    await captureRedirect(() => chooseTrackAction(form({ memorialId, trackId: track.id })));

    const page = (await DashboardPage({ params: params(memorialId) })) as Node;
    expect(textOf(page)).toContain('Make the video');
    expect(hrefsOf(page)).toContain(`/m/${memorialId}/deliver`);
  });
});

/* -------------------------------------------------------------------------- */
/* the deliver screen                                                          */
/* -------------------------------------------------------------------------- */

describe('the deliver screen', () => {
  async function ready(): Promise<string> {
    const memorialId = await memorialWithSlideshow();
    const track = bundledTracks(db())[0];
    if (!track) throw new Error('no tracks');
    await captureRedirect(() => chooseTrackAction(form({ memorialId, trackId: track.id })));
    return memorialId;
  }

  it('preselects the service cut and offers the family one', async () => {
    const memorialId = await ready();
    const page = (await DeliverPage({
      params: params(memorialId),
      searchParams: search(),
    })) as Node;
    const text = textOf(page);

    expect(text).toContain('The service version');
    expect(text).toContain('Prepare the final video');
    expect(text).toContain('Quick preview render');
    expect(text).toContain('5–15 minutes');
    expect(text).toContain('close this page');
    expect(hrefsOf(page)).toContain(`/m/${memorialId}/deliver?cut=family`);
  });

  it('queues the final render, and the backup alongside it when asked', async () => {
    const memorialId = await ready();
    const destination = await captureRedirect(() =>
      startRenderAction(form({ memorialId, cut: 'service', preset: 'final1080', backup: 'yes' })),
    );
    expect(destination).toBe(`/m/${memorialId}/deliver?cut=service&started=1`);

    const rows = rendersFor(memorialId);
    expect(rows.map((row) => row.preset).sort()).toEqual(['backup720', 'final1080']);
    expect(rows.every((row) => row.cut === 'service')).toBe(true);
    expect(rows.every((row) => row.status === 'queued')).toBe(true);
  });

  it('queues only a draft for the quick preview', async () => {
    const memorialId = await ready();
    await captureRedirect(() =>
      startRenderAction(form({ memorialId, cut: 'service', preset: 'draft360' })),
    );
    expect(rendersFor(memorialId).map((row) => row.preset)).toEqual(['draft360']);
  });

  it('shows honest progress while a render is running', async () => {
    const memorialId = await ready();
    await captureRedirect(() =>
      startRenderAction(form({ memorialId, cut: 'service', preset: 'final1080' })),
    );
    const job = rendersFor(memorialId)[0];
    if (!job) throw new Error('no render job');
    updateById(db(), renderJobs, job.id, {
      status: 'running',
      progress: 0.4,
      startedAt: Date.now() - 120_000,
    });

    const text = textOf(
      (await DeliverPage({ params: params(memorialId), searchParams: search() })) as Node,
    );
    expect(text).toMatch(/About \d+ more minutes/);
    expect(text).toContain('close this page');
    expect(text).not.toContain('Download');
  });

  it('offers a dignified download, the director card and the USB guidance once it is done', async () => {
    const memorialId = await ready();
    await captureRedirect(() =>
      startRenderAction(form({ memorialId, cut: 'service', preset: 'final1080' })),
    );
    const job = rendersFor(memorialId)[0];
    if (!job) throw new Error('no render job');
    updateById(db(), renderJobs, job.id, {
      status: 'done',
      progress: 1,
      durationSec: 300,
      outputBlobKey: `memorial/${memorialId}/render/${job.id}.mp4`,
      ffprobeMeta: { width: 1920, height: 1080, videoCodec: 'h264', audioCodec: 'aac' },
    });

    const page = (await DeliverPage({
      params: params(memorialId),
      searchParams: search(),
    })) as Node;
    const text = textOf(page);

    expect(text).toContain('Ruth-Kelleher-Celebration-of-Life-Service.mp4');
    expect(text).toContain('FAT32');
    expect(text).toContain('funeral director');
    expect(hrefsOf(page)).toContain(`/api/renders/${job.id}`);
  });

  it('explains itself rather than offering a button when there is no slideshow yet', async () => {
    const memorialId = await signedInMemorial();
    const text = textOf(
      (await DeliverPage({ params: params(memorialId), searchParams: search() })) as Node,
    );
    expect(text).toContain('not ready yet');
  });

  it('reflects a failure without blaming the family', async () => {
    const memorialId = await ready();
    await captureRedirect(() =>
      startRenderAction(form({ memorialId, cut: 'service', preset: 'final1080' })),
    );
    const job = rendersFor(memorialId)[0];
    if (!job) throw new Error('no render job');
    updateById(db(), renderJobs, job.id, { status: 'failed', error: 'ffmpeg fell over' });

    const text = textOf(
      (await DeliverPage({ params: params(memorialId), searchParams: search() })) as Node,
    );
    expect(text).toContain('Something went wrong');
    // Never the raw error, and never a suggestion that they did something wrong.
    expect(text).not.toContain('ffmpeg fell over');
  });
});

/* -------------------------------------------------------------------------- */
/* the cards                                                                   */
/* -------------------------------------------------------------------------- */

describe('the printable cards', () => {
  it('prints a card naming the file, the length and the request to test it', async () => {
    const memorialId = await memorialWithSlideshow();
    const track = bundledTracks(db())[0];
    if (!track) throw new Error('no tracks');
    await captureRedirect(() => chooseTrackAction(form({ memorialId, trackId: track.id })));

    const text = textOf(
      (await DirectorCardPage({ params: params(memorialId), searchParams: search() })) as Node,
    );
    expect(text).toContain('Ruth-Kelleher-Celebration-of-Life-Service.mp4');
    expect(text).toContain('before the service');
    expect(text).toContain('H.264');
    expect(text).toContain('music is in the file');
  });

  it('prints a timing card only when the video is silent', async () => {
    const memorialId = await memorialWithSlideshow();
    await captureRedirect(() =>
      chooseSideloadedAction(form({ memorialId, title: 'Danny Boy', bpm: '68' })),
    );

    const text = textOf(
      (await TimingCardPage({ params: params(memorialId), searchParams: search() })) as Node,
    );
    expect(text).toContain('Danny Boy');
    expect(text).toContain('fades up from black');
    expect(text).toContain('nobody will notice');
  });

  it('says a timing card is unnecessary when the music is in the file', async () => {
    const memorialId = await memorialWithSlideshow();
    const track = bundledTracks(db())[0];
    if (!track) throw new Error('no tracks');
    await captureRedirect(() => chooseTrackAction(form({ memorialId, trackId: track.id })));

    const text = textOf(
      (await TimingCardPage({ params: params(memorialId), searchParams: search() })) as Node,
    );
    expect(text).toContain('No timing card is needed');
  });

  it('serves the same words as plain text, to an organizer only', async () => {
    const memorialId = await memorialWithSlideshow();
    const response = await getCardText(
      new Request(`http://localhost/api/deliver/${memorialId}/card.txt?cut=service`),
      { params: params(memorialId) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    const body = await response.text();
    expect(body).toContain('File name: Ruth-Kelleher-Celebration-of-Life-Service.mp4');

    cookieJar.clear();
    const loggedOut = await getCardText(
      new Request(`http://localhost/api/deliver/${memorialId}/card.txt`),
      { params: params(memorialId) },
    );
    expect(loggedOut.status).toBe(403);
  });
});

/* -------------------------------------------------------------------------- */
/* the authorised routes                                                       */
/* -------------------------------------------------------------------------- */

describe('downloading the video', () => {
  async function finishedRender(): Promise<{ memorialId: string; jobId: string }> {
    const memorialId = await memorialWithSlideshow();
    const track = bundledTracks(db())[0];
    if (!track) throw new Error('no tracks');
    await captureRedirect(() => chooseTrackAction(form({ memorialId, trackId: track.id })));
    await captureRedirect(() =>
      startRenderAction(form({ memorialId, cut: 'service', preset: 'final1080' })),
    );

    const job = rendersFor(memorialId)[0];
    if (!job) throw new Error('no render job');

    const key = `memorial/${memorialId}/render/${job.id}.mp4`;
    await getBlobStore().put(key, Buffer.from('not really an mp4'), 'video/mp4');
    updateById(db(), renderJobs, job.id, {
      status: 'done',
      progress: 1,
      durationSec: 300,
      outputBlobKey: key,
    });
    return { memorialId, jobId: job.id };
  }

  it('serves the file with the family’s own name on it', async () => {
    const { jobId } = await finishedRender();
    const response = await downloadRender(new Request(`http://localhost/api/renders/${jobId}`), {
      params: Promise.resolve({ renderJobId: jobId }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(response.headers.get('content-disposition')).toContain(
      'Ruth-Kelleher-Celebration-of-Life-Service.mp4',
    );
    // Nothing about a family's video may sit in a shared cache.
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('answers a range request so a dropped download can resume', async () => {
    const { jobId } = await finishedRender();
    const response = await downloadRender(
      new Request(`http://localhost/api/renders/${jobId}`, { headers: { range: 'bytes=0-3' } }),
      { params: Promise.resolve({ renderJobId: jobId }) },
    );
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toMatch(/^bytes 0-3\//);
  });

  it('refuses a signed-out visitor and another family’s organizer alike', async () => {
    const { jobId } = await finishedRender();

    cookieJar.clear();
    const loggedOut = await downloadRender(new Request(`http://localhost/api/renders/${jobId}`), {
      params: Promise.resolve({ renderJobId: jobId }),
    });
    expect(loggedOut.status).toBe(403);

    // Signed in, but as somebody else entirely.
    await signedInMemorial();
    const stranger = await downloadRender(new Request(`http://localhost/api/renders/${jobId}`), {
      params: Promise.resolve({ renderJobId: jobId }),
    });
    expect(stranger.status).toBe(403);
  });

  it('will not hand over a render that has not finished', async () => {
    const memorialId = await memorialWithSlideshow();
    const project = latestProject(db(), memorialId);
    const job = insertOne(db(), renderJobs, {
      memorialId,
      projectId: project?.id,
      cut: 'service',
      preset: 'final1080',
      status: 'running',
    } as never) as { id: string };

    const response = await downloadRender(new Request(`http://localhost/api/renders/${job.id}`), {
      params: Promise.resolve({ renderJobId: job.id }),
    });
    expect(response.status).toBe(403);
  });
});

describe('previewing a track', () => {
  it('serves library audio to a signed-in organizer and nobody else', async () => {
    await memorialWithSlideshow();
    const track = bundledTracks(db())[0];
    if (!track) throw new Error('no tracks');

    const ok = await getMusic(new Request(`http://localhost/api/music/${track.id}`), {
      params: Promise.resolve({ trackId: track.id }),
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toContain('audio/');
    expect(ok.headers.get('cache-control')).toContain('private');

    cookieJar.clear();
    const loggedOut = await getMusic(new Request(`http://localhost/api/music/${track.id}`), {
      params: Promise.resolve({ trackId: track.id }),
    });
    expect(loggedOut.status).toBe(403);
  });

  it('keeps a family’s own recording to that family', async () => {
    const memorialId = await memorialWithSlideshow();
    const { recordFamilyTrack } = await import('@col/core');
    const { beatGridFromBpm } = await import('@col/media');

    const key = `memorial/${memorialId}/music/theirs.m4a`;
    await getBlobStore().put(key, Buffer.from('audio bytes'), 'audio/mp4');
    const track = recordFamilyTrack(db(), {
      memorialId,
      title: 'Dad at the piano',
      blobKey: key,
      durationSec: 120,
      bpm: 70,
      beatGrid: beatGridFromBpm(70, 120),
      ownershipStatement: 'This recording belongs to our family.',
    });

    const mine = await getMusic(new Request(`http://localhost/api/music/${track.id}`), {
      params: Promise.resolve({ trackId: track.id }),
    });
    expect(mine.status).toBe(200);

    // A different family, signed in perfectly legitimately, gets nothing.
    cookieJar.clear();
    await signedInMemorial();
    const theirs = await getMusic(new Request(`http://localhost/api/music/${track.id}`), {
      params: Promise.resolve({ trackId: track.id }),
    });
    expect(theirs.status).toBe(403);
  });
});
