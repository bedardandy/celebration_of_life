/**
 * Asking for a video, and what the screen says while it is being made.
 *
 * The progress copy is tested as carefully as the queueing, because it is a
 * promise: "you can close this page" is only true if the work is durable, and
 * "about four minutes" is only allowed once there is enough evidence to say it.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  createTestDb,
  insertOne,
  jobs,
  listWhere,
  memorials,
  renderJobs,
  slideshowProjects,
  updateById,
  type Db,
  type Memorial,
  type RenderJob,
  type SlideshowProject,
} from '@col/db';
import {
  RENDER_PRESET_LABELS,
  describeRenderProgress,
  hasDeliverable,
  isRendering,
  latestRender,
  renderJobsFor,
  requestRender,
} from './render-jobs';
import { USB_STEPS, buildDirectorCard, buildTimingCard, cardToText } from './cards';

let db: Db;
let memorial: Memorial;
let project: SlideshowProject;

beforeEach(() => {
  db = createTestDb();
  memorial = insertOne(db, memorials, { decedentName: 'Ruth Kelleher' } as never);
  project = insertOne(db, slideshowProjects, { memorialId: memorial.id } as never);
});

describe('asking for a render', () => {
  it('records the render and puts durable work on the queue', () => {
    const { renderJob, reused } = requestRender(db, {
      memorialId: memorial.id,
      projectId: project.id,
      cut: 'service',
      preset: 'final1080',
    });

    expect(reused).toBe(false);
    expect(renderJob.status).toBe('queued');
    expect(renderJob.progress).toBe(0);

    const queued = listWhere(db, jobs).filter((job) => job.type === 'render');
    expect(queued).toHaveLength(1);
    // Above photo analysis and EDL generation: a render is the only job with a
    // funeral waiting at the end of it.
    expect(queued[0]?.priority).toBe(10);
    expect(renderJob.jobId).toBe(queued[0]?.id);
  });

  it('hands back the same render when somebody presses the button twice', () => {
    const first = requestRender(db, {
      memorialId: memorial.id,
      projectId: project.id,
      cut: 'service',
      preset: 'final1080',
    });
    const second = requestRender(db, {
      memorialId: memorial.id,
      projectId: project.id,
      cut: 'service',
      preset: 'final1080',
    });

    expect(second.reused).toBe(true);
    expect(second.renderJob.id).toBe(first.renderJob.id);
    expect(listWhere(db, jobs).filter((job) => job.type === 'render')).toHaveLength(1);
  });

  it('starts a fresh one after the last finished, because the slideshow may have changed', () => {
    const first = requestRender(db, {
      memorialId: memorial.id,
      projectId: project.id,
      cut: 'service',
      preset: 'final1080',
    });
    updateById(db, renderJobs, first.renderJob.id, { status: 'done', progress: 1 });

    const second = requestRender(db, {
      memorialId: memorial.id,
      projectId: project.id,
      cut: 'service',
      preset: 'final1080',
    });
    expect(second.reused).toBe(false);
    expect(second.renderJob.id).not.toBe(first.renderJob.id);
  });

  it('treats the two cuts and the three presets as different files', () => {
    requestRender(db, {
      memorialId: memorial.id,
      projectId: project.id,
      cut: 'service',
      preset: 'final1080',
    });
    requestRender(db, {
      memorialId: memorial.id,
      projectId: project.id,
      cut: 'family',
      preset: 'final1080',
    });
    requestRender(db, {
      memorialId: memorial.id,
      projectId: project.id,
      cut: 'service',
      preset: 'backup720',
    });
    expect(renderJobsFor(db, memorial.id)).toHaveLength(3);
  });

  it('refuses a project belonging to a different family', () => {
    const other = insertOne(db, memorials, { decedentName: 'Someone Else' } as never);
    expect(() =>
      requestRender(db, {
        memorialId: other.id,
        projectId: project.id,
        cut: 'service',
        preset: 'final1080',
      }),
    ).toThrow(/does not belong/);
  });

  it('finds the newest render of a given cut and preset', () => {
    requestRender(db, {
      memorialId: memorial.id,
      projectId: project.id,
      cut: 'service',
      preset: 'draft360',
    });
    const found = latestRender(db, memorial.id, 'service', 'draft360');
    expect(found?.preset).toBe('draft360');
    expect(latestRender(db, memorial.id, 'family', 'draft360')).toBeUndefined();
  });
});

describe('what the deliver screen knows', () => {
  it('reports rendering while work is in flight and delivery once a file exists', () => {
    expect(isRendering(db, memorial.id)).toBe(false);
    expect(hasDeliverable(db, memorial.id)).toBe(false);

    const { renderJob } = requestRender(db, {
      memorialId: memorial.id,
      projectId: project.id,
      cut: 'service',
      preset: 'final1080',
    });
    expect(isRendering(db, memorial.id)).toBe(true);

    updateById(db, renderJobs, renderJob.id, {
      status: 'done',
      outputBlobKey: `memorial/${memorial.id}/render/x.mp4`,
    });
    expect(isRendering(db, memorial.id)).toBe(false);
    expect(hasDeliverable(db, memorial.id)).toBe(true);
  });

  it('does not call a finished job with no file a deliverable', () => {
    const { renderJob } = requestRender(db, {
      memorialId: memorial.id,
      projectId: project.id,
      cut: 'service',
      preset: 'final1080',
    });
    updateById(db, renderJobs, renderJob.id, { status: 'done' });
    expect(hasDeliverable(db, memorial.id)).toBe(false);
  });
});

describe('what the screen says while waiting', () => {
  const job = (over: Partial<RenderJob>): RenderJob =>
    ({ status: 'running', progress: 0, startedAt: null, ...over }) as RenderJob;

  it('says nothing is happening when nothing is', () => {
    const view = describeRenderProgress(undefined);
    expect(view.working).toBe(false);
    expect(view.message).toContain('Nothing is being made');
  });

  it('promises the page can be closed while a job is queued', () => {
    const view = describeRenderProgress(job({ status: 'queued' }));
    expect(view.working).toBe(true);
    expect(view.message).toContain('close this page');
  });

  it('refuses to estimate before there is evidence', () => {
    const now = Date.now();
    const view = describeRenderProgress(job({ progress: 0.04, startedAt: now - 10_000 }), { now });
    expect(view.message).toContain('5–15 minutes');
    expect(view.message).not.toMatch(/About \d+ more/);
  });

  it('extrapolates once it has some, and rounds up rather than down', () => {
    const now = Date.now();
    // A quarter done after a minute: three minutes left.
    const view = describeRenderProgress(job({ progress: 0.25, startedAt: now - 60_000 }), { now });
    expect(view.percent).toBe(25);
    expect(view.message).toMatch(/About 3 more minutes/);
    expect(view.message).toContain('close this page');
  });

  it('is done, and says so plainly', () => {
    const view = describeRenderProgress(job({ status: 'done', progress: 1 }));
    expect(view.done).toBe(true);
    expect(view.percent).toBe(100);
    expect(view.message).toContain('ready to download');
  });

  it('explains a failure without blaming anyone, and says it can be retried', () => {
    const view = describeRenderProgress(job({ status: 'failed', progress: 0.4 }));
    expect(view.failed).toBe(true);
    expect(view.working).toBe(false);
    expect(view.message).toContain('again');
  });

  it('never reports a percentage outside 0–100', () => {
    expect(describeRenderProgress(job({ progress: 4 })).percent).toBe(100);
    expect(describeRenderProgress(job({ progress: -1 })).percent).toBe(0);
  });

  it('names each file in words rather than presets', () => {
    expect(RENDER_PRESET_LABELS.final1080).not.toMatch(/1080p?$|final/i);
    expect(RENDER_PRESET_LABELS.draft360).toBe('Quick preview');
  });
});

describe('the card for the funeral director', () => {
  const card = buildDirectorCard({
    decedentName: 'Ruth Kelleher',
    cut: 'service',
    preset: 'final1080',
    durationSec: 312,
    width: 1920,
    height: 1080,
    audioMode: 'cleared',
    placementNote: { context: 'The vigil', guidance: 'This is the natural home for a tribute.' },
    serviceDateLabel: 'Friday 14 March, 11:00',
    organizerName: 'Anne Doyle',
    organizerContact: 'anne@example.test',
  });

  it('leads with the file name, because that is what gets typed and read aloud', () => {
    expect(card.filename).toBe('Ruth-Kelleher-Celebration-of-Life-Service.mp4');
    expect(card.lines[0]?.label).toBe('File name');
    expect(card.lines[0]?.value).toBe(card.filename);
  });

  it('states the length, the format and the sound in the venue’s terms', () => {
    const values = Object.fromEntries(card.lines.map((line) => [line.label, line.value]));
    expect(values['Length']).toBe('5 min 12 sec');
    expect(values['Format']).toContain('H.264');
    expect(values['Format']).toContain('1920×1080');
    expect(values['Sound']).toContain('music is in the file');
  });

  it('shouts about the silent case, because that is the one that causes a panic', () => {
    const silent = buildDirectorCard({
      decedentName: 'Ruth Kelleher',
      cut: 'service',
      preset: 'final1080',
      durationSec: 300,
      audioMode: 'sideloaded',
    });
    const sound = silent.lines.find((line) => line.label === 'Sound')?.value ?? '';
    expect(sound).toContain('SILENT');
    expect(sound).toContain('timing card');
  });

  it('asks, above everything else, that somebody plays it first', () => {
    expect(card.emphasis).toContain('before the service');
    expect(card.checklist.length).toBeGreaterThanOrEqual(4);
  });

  it('carries the tradition’s placement note in the pack’s own words', () => {
    expect(card.placementNote?.context).toBe('The vigil');
    expect(cardToText(card)).toContain('This is the natural home for a tribute.');
  });

  it('reads as plain text for an email or a telephone', () => {
    const text = cardToText(card);
    expect(text).toContain('Ruth Kelleher — tribute video');
    expect(text).toContain('File name: Ruth-Kelleher-Celebration-of-Life-Service.mp4');
    expect(text).toContain('  1. ');
    expect(text).not.toContain('<');
  });
});

describe('the timing card for a silent video', () => {
  const card = buildTimingCard({
    decedentName: 'Ruth Kelleher',
    songTitle: 'Danny Boy',
    songArtist: 'Her brother, on the fiddle',
    durationSec: 300,
    bpm: 68,
  });

  it('names the song and the cue somebody can actually see', () => {
    expect(card.song).toBe('Danny Boy — Her brother, on the fiddle');
    const cue = card.lines.find((line) => line.label === 'Start the song')?.value ?? '';
    expect(cue).toContain('fades up from black');
  });

  it('says the silence is deliberate, in as many words', () => {
    expect(card.lines.some((line) => line.value.includes('deliberate'))).toBe(true);
  });

  it('gives permission to be a few seconds out', () => {
    expect(card.checklist.join(' ')).toContain('nobody will notice');
  });

  it('mentions the tempo only when there is one', () => {
    const noTempo = buildTimingCard({
      decedentName: 'Ruth Kelleher',
      songTitle: 'Danny Boy',
      durationSec: 300,
    });
    expect(noTempo.lines.some((line) => line.label === 'Timing')).toBe(false);
    expect(card.lines.some((line) => line.label === 'Timing')).toBe(true);
  });
});

describe('the USB guidance', () => {
  it('says FAT32, the root of the stick, and take a second copy', () => {
    const text = USB_STEPS.join(' ');
    expect(text).toContain('FAT32');
    expect(text).toContain('top level');
    expect(text).toMatch(/second stick|email/);
  });
});
