/**
 * The slideshow journey, headless.
 *
 * An organiser chooses a shape, waits while it is put together, watches it, and
 * then changes things: a caption, an order, a length, a photograph they would
 * rather not show. Every one of those has to end with a new EDL version and a
 * player holding the new timeline — if an edit silently does not reach the
 * preview, a family approves one video and a room watches another.
 *
 * The mock provider is forced by NODE_ENV=test, so this never touches a model.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

const workdir = mkdtempSync(path.join(tmpdir(), 'col-slideshow-test-'));
process.env['DATABASE_URL'] = `file:${path.join(workdir, 'slideshow.db')}`;
process.env['SESSION_SECRET'] = 'slideshow-test-secret';
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
const {
  longerAction,
  moveDownAction,
  removeSlideAction,
  restoreSlideAction,
  setCaptionAction,
  swapPhotoAction,
} = await import('./m/[memorialId]/preview/actions');
const StoryShapePage = (await import('./m/[memorialId]/story-shape/page')).default;
const PreviewPage = (await import('./m/[memorialId]/preview/page')).default;
const DashboardPage = (await import('./m/[memorialId]/page')).default;
const SlideshowPage = (await import('./m/[memorialId]/slideshow/page')).default;
const {
  DevConsoleTransport,
  buildContext,
  currentDoc,
  generateEdl,
  latestProject,
  previewView,
  projectEdl,
  saveEdl,
  setMailTransport,
  subjectOf,
} = await import('@col/core');
const { getById, insertOne, listWhere, jobs, mediaAssets, memorials, memoryNotes } =
  await import('@col/db');
const { resetMockState } = await import('@col/ai');

afterAll(() => {
  setMailTransport(undefined);
  rmSync(workdir, { recursive: true, force: true });
});

beforeAll(() => {
  setMailTransport(new DevConsoleTransport(() => {}));
  db();
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
        decedentName: 'Margaret Anne Doyle',
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

const MEMORY = 'She always said the garden would outlive her.';

async function memorialWithPhotos(count = 12): Promise<{ memorialId: string; assetIds: string[] }> {
  const memorialId = await signedInMemorial();
  const assetIds = Array.from({ length: count }, (_, i) =>
    addApprovedPhoto(memorialId, i, 1950 + i * 6),
  );
  insertOne(db(), memoryNotes, {
    memorialId,
    authorName: 'Her daughter, Anne',
    text: MEMORY,
    approved: true,
  } as never);
  return { memorialId, assetIds };
}

/** The worker, inlined: the queue is tested in the worker package. */
async function buildSlideshow(memorialId: string): Promise<void> {
  const project = latestProject(db(), memorialId);
  if (!project) throw new Error('no slideshow project');
  const result = await generateEdl(buildContext(db(), memorialId, project.id));
  saveEdl(db(), project.id, result.edl, { status: 'ready' });
}

/* -------------------------------------------------------------------------- */
/* rendering server components without a browser                               */
/* -------------------------------------------------------------------------- */

type Node = ReactElement | string | number | null | undefined | boolean | Node[];

function isElement(node: unknown): node is ReactElement {
  return typeof node === 'object' && node !== null && 'props' in node && 'type' in node;
}

/**
 * Every string of text a server component put on the page.
 *
 * It walks props as well as children, because `StepScreen` takes the title, the
 * helper and the primary action as props — and those are exactly the words a
 * person reads first. Attribute-shaped props are skipped so a class name never
 * counts as copy.
 */
const NOT_TEXT = new Set([
  'className',
  'style',
  'href',
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

/** Components that need a browser to run; their props are inspected instead. */
const CLIENT_COMPONENTS = new Set([
  'PreviewPlayer',
  'CaptionField',
  'WaitingRefresh',
  'SavedIndicator',
  'RemoveMemorial',
]);

function textOf(node: Node): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (!isElement(node)) return '';

  const props = node.props as Record<string, unknown>;
  const type = node.type as unknown;
  if (typeof type === 'function') {
    const name = (type as { displayName?: string; name?: string }).displayName ?? (type as { name?: string }).name ?? '';
    if (!CLIENT_COMPONENTS.has(name)) {
      try {
        const rendered = (type as (p: unknown) => unknown)(props);
        // Async server components are called directly by the test instead.
        if (!(rendered instanceof Promise)) return textOf(rendered as Node);
      } catch {
        // A component that needs a browser contributes nothing here, which is
        // the honest answer rather than a failed test.
      }
    }
  }

  return Object.entries(props)
    .filter(([key]) => !NOT_TEXT.has(key))
    .map(([, value]) => textOf(value as Node))
    .join(' ');
}

/** The first child element whose component is named `name`, with its props. */
function findComponent(node: Node, name: string): { props: Record<string, unknown> } | undefined {
  if (node == null || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findComponent(child, name);
      if (hit) return hit;
    }
    return undefined;
  }
  if (!isElement(node)) return undefined;
  const type = node.type as { name?: string; displayName?: string } | string;
  if (typeof type !== 'string' && (type.displayName === name || type.name === name)) {
    return { props: node.props as Record<string, unknown> };
  }
  return findComponent((node.props as { children?: Node }).children ?? null, name);
}

/* -------------------------------------------------------------------------- */

describe('choosing a shape', () => {
  it('recommends one, offers the other two, and explains itself', async () => {
    const { memorialId } = await memorialWithPhotos();
    const page = await StoryShapePage({ params: Promise.resolve({ memorialId }) });
    const text = textOf(page as Node);

    expect(text).toContain('How should their story run?');
    expect(text).toContain('Suggested');
    // Photographs spread from the fifties to the twenty-tens: a chronology.
    expect(text).toContain('Beginning to end');
    expect(text).toContain('decades');
    expect(text).toContain('The things that mattered');
    expect(text).toContain('Mostly in order');
  });

  it('sends someone with no chosen photographs back to the grid', async () => {
    const memorialId = await signedInMemorial();
    const page = await StoryShapePage({ params: Promise.resolve({ memorialId }) });
    expect(textOf(page as Node)).toContain('No photos chosen yet');
  });

  it('writes the choice onto the story, queues the job, and goes to the preview', async () => {
    const { memorialId } = await memorialWithPhotos();

    const destination = await captureRedirect(() =>
      chooseShapeAction(form({ memorialId, structure: 'thematic' })),
    );
    expect(destination).toBe(`/m/${memorialId}/preview?waiting=1`);

    const memorial = getById(db(), memorials, memorialId);
    if (!memorial) throw new Error('memorial vanished');
    expect(currentDoc(db(), memorialId, subjectOf(memorial)).doc.structure).toBe('thematic');

    const queued = listWhere(db(), jobs).filter((job) => job.type === 'generate-edl');
    expect(queued).toHaveLength(1);
    expect(latestProject(db(), memorialId)).toBeDefined();
  });
});

describe('waiting', () => {
  it('says what is happening rather than showing an empty player', async () => {
    const { memorialId } = await memorialWithPhotos();
    await captureRedirect(() => chooseShapeAction(form({ memorialId, structure: 'chrono' })));

    const page = await PreviewPage({
      params: Promise.resolve({ memorialId }),
      searchParams: Promise.resolve({ waiting: '1' }),
    });
    const text = textOf(page as Node);
    expect(text).toContain('story together');
    expect(text).toContain('minute or two');
    expect(findComponent(page as Node, 'PreviewPlayer')).toBeUndefined();
  });

  it('signposts from the dashboard card to wherever the family actually is', async () => {
    const { memorialId } = await memorialWithPhotos();
    expect(
      await captureRedirect(() => SlideshowPage({ params: Promise.resolve({ memorialId }) })),
    ).toBe(`/m/${memorialId}/story-shape`);

    await captureRedirect(() => chooseShapeAction(form({ memorialId, structure: 'chrono' })));
    expect(
      await captureRedirect(() => SlideshowPage({ params: Promise.resolve({ memorialId }) })),
    ).toBe(`/m/${memorialId}/preview?waiting=1`);

    await buildSlideshow(memorialId);
    expect(
      await captureRedirect(() => SlideshowPage({ params: Promise.resolve({ memorialId }) })),
    ).toBe(`/m/${memorialId}/preview`);
  });
});

describe('the preview screen', () => {
  async function ready() {
    const { memorialId, assetIds } = await memorialWithPhotos();
    await captureRedirect(() => chooseShapeAction(form({ memorialId, structure: 'chrono' })));
    await buildSlideshow(memorialId);
    return { memorialId, assetIds };
  }

  async function render(memorialId: string, cut?: string) {
    return (await PreviewPage({
      params: Promise.resolve({ memorialId }),
      searchParams: Promise.resolve(cut ? { cut } : {}),
    })) as Node;
  }

  function playerProps(page: Node) {
    const player = findComponent(page, 'PreviewPlayer');
    if (!player) throw new Error('the preview screen has no player on it');
    return player.props as {
      edl: { slides: Record<string, { kind: string; caption?: { text: string } }> };
      timeline: { cut: string; slides: { slideId: string }[]; totalSec: number };
      assetUrlMap: Record<string, string>;
      edlVersion: number;
    };
  }

  it('renders a player holding the resolved timeline and authorised photo URLs', async () => {
    const { memorialId, assetIds } = await ready();
    const page = await render(memorialId);
    const props = playerProps(page);

    expect(props.timeline.cut).toBe('family');
    expect(props.timeline.slides.length).toBeGreaterThan(1);
    expect(props.timeline.totalSec).toBeGreaterThan(0);
    for (const assetId of assetIds) {
      expect(props.assetUrlMap[assetId]).toBe(`/api/assets/${assetId}?variant=web1600`);
    }
    // Every URL goes through the auth-gated route; no blob key is ever exposed.
    for (const url of Object.values(props.assetUrlMap)) {
      expect(url.startsWith('/api/assets/')).toBe(true);
    }

    const text = textOf(page);
    expect(text).toContain('Watch it through');
    expect(text).toContain('Looks good — choose music next');
    expect(text).toContain('The service version (about five minutes)');
  });

  it('offers the service cut as a projection of the same slides', async () => {
    const { memorialId } = await ready();
    const family = playerProps(await render(memorialId));
    const service = playerProps(await render(memorialId, 'service'));

    expect(service.timeline.cut).toBe('service');
    expect(service.timeline.slides.length).toBeLessThanOrEqual(family.timeline.slides.length);
    expect(service.timeline.totalSec).toBeLessThanOrEqual(family.timeline.totalSec + 0.001);
  });
});

describe('adjusting slides', () => {
  async function ready() {
    const { memorialId } = await memorialWithPhotos();
    await captureRedirect(() => chooseShapeAction(form({ memorialId, structure: 'chrono' })));
    await buildSlideshow(memorialId);
    const project = latestProject(db(), memorialId);
    const edl = projectEdl(project);
    if (!project || !edl) throw new Error('no slideshow');
    const view = previewView(edl, 'family');
    const photoRow = view.rows.find((row) => row.slide.kind === 'photo');
    if (!photoRow) throw new Error('no photograph in the slideshow');
    return { memorialId, version: project.edlVersion, slideId: photoRow.slideId };
  }

  function current(memorialId: string) {
    const project = latestProject(db(), memorialId);
    const edl = projectEdl(project);
    if (!project || !edl) throw new Error('no slideshow');
    return { project, edl };
  }

  it('writes a caption straight through to the player payload', async () => {
    const { memorialId, version, slideId } = await ready();

    await setCaptionAction(
      form({ memorialId, slideId, cut: 'family', caption: '  The kitchen table, 1974 ' }),
    );

    const { project, edl } = current(memorialId);
    expect(project.edlVersion).toBe(version + 1);
    const slide = edl.slides[slideId];
    expect(slide?.kind === 'photo' && slide.caption?.text).toBe('The kitchen table, 1974');

    const page = (await PreviewPage({
      params: Promise.resolve({ memorialId }),
      searchParams: Promise.resolve({}),
    })) as Node;
    expect(textOf(page)).toContain('The kitchen table, 1974');
  });

  it('holds a photograph half a second longer, inside the band', async () => {
    const { memorialId, slideId } = await ready();
    const before = current(memorialId).edl.slides[slideId]?.durationSec ?? 0;

    await captureRedirect(() => longerAction(form({ memorialId, slideId, cut: 'family' })));

    const after = current(memorialId).edl.slides[slideId]?.durationSec ?? 0;
    expect(after).toBeCloseTo(Math.min(7, before + 0.5), 5);
    expect(after).toBeGreaterThanOrEqual(3);
    expect(after).toBeLessThanOrEqual(7);
  });

  it('moves a slide down the list', async () => {
    const { memorialId, slideId } = await ready();
    const order = () =>
      previewView(current(memorialId).edl, 'family').rows.map((row) => row.slideId);
    const before = order();

    const destination = await captureRedirect(() =>
      moveDownAction(form({ memorialId, slideId, cut: 'family' })),
    );
    expect(destination).toBe(`/m/${memorialId}/preview#slide-${slideId}`);

    const after = order();
    expect(after.indexOf(slideId)).toBe(before.indexOf(slideId) + 1);
    expect(after).toHaveLength(before.length);
  });

  it('removes a slide from the video and puts it back exactly where it was', async () => {
    const { memorialId, slideId } = await ready();
    const before = previewView(current(memorialId).edl, 'family').rows.map((row) => row.slideId);

    await captureRedirect(() => removeSlideAction(form({ memorialId, slideId, cut: 'family' })));

    const removed = current(memorialId).edl;
    expect(removed.omittedSlideIds).toContain(slideId);
    expect(removed.slides[slideId]).toBeDefined();
    const view = previewView(removed, 'family');
    expect(view.rows.map((row) => row.slideId)).not.toContain(slideId);
    expect(view.removed.map((row) => row.slideId)).toContain(slideId);

    await captureRedirect(() => restoreSlideAction(form({ memorialId, slideId, cut: 'family' })));
    expect(previewView(current(memorialId).edl, 'family').rows.map((row) => row.slideId)).toEqual(
      before,
    );
  });

  it('swaps in a different photograph, keeping the framing and the hold', async () => {
    const { memorialId, slideId } = await ready();
    const before = current(memorialId).edl.slides[slideId];
    if (before?.kind !== 'photo') throw new Error('expected a photograph');

    // Any approved photograph the slideshow is not already using.
    const used = new Set(
      Object.values(current(memorialId).edl.slides)
        .filter((slide) => slide.kind === 'photo')
        .map((slide) => (slide.kind === 'photo' ? slide.assetId : '')),
    );
    const spare = addApprovedPhoto(memorialId, 99, 1994);
    expect(used.has(spare)).toBe(false);

    await captureRedirect(() =>
      swapPhotoAction(form({ memorialId, slideId, cut: 'family', assetId: spare })),
    );

    const after = current(memorialId).edl.slides[slideId];
    if (after?.kind !== 'photo') throw new Error('expected a photograph');
    expect(after.assetId).toBe(spare);
    expect(after.kenBurns).toEqual(before.kenBurns);
    expect(after.durationSec).toBe(before.durationSec);
  });

  it('bumps the version on every edit, so the player never shows a stale timeline', async () => {
    const { memorialId, version, slideId } = await ready();
    await captureRedirect(() => longerAction(form({ memorialId, slideId, cut: 'family' })));
    await captureRedirect(() => removeSlideAction(form({ memorialId, slideId, cut: 'family' })));
    expect(current(memorialId).project.edlVersion).toBe(version + 2);
  });

  it('ignores a photograph belonging to a different family', async () => {
    const { memorialId, slideId } = await ready();
    const other = await memorialWithPhotos(2);
    const theirs = other.assetIds[0] as string;

    // Signing back in as the first organiser: the swap must not cross memorials.
    cookieJar.clear();
    const { memorialId: mine, slideId: mySlide } = await ready();
    expect(mine).not.toBe(memorialId);
    expect(mySlide).toBeDefined();

    await captureRedirect(() =>
      swapPhotoAction(form({ memorialId: mine, slideId: mySlide, cut: 'family', assetId: theirs })),
    );
    const slide = current(mine).edl.slides[mySlide];
    expect(slide?.kind === 'photo' && slide.assetId).not.toBe(theirs);
    expect(slideId).toBeDefined();
  });
});

describe('the dashboard card', () => {
  it('unlocks and points at the preview once a slideshow exists', async () => {
    const { memorialId } = await memorialWithPhotos();
    const locked = textOf((await DashboardPage({ params: Promise.resolve({ memorialId }) })) as Node);
    expect(locked).toContain('Build the slideshow');

    await captureRedirect(() => chooseShapeAction(form({ memorialId, structure: 'chrono' })));
    await buildSlideshow(memorialId);

    const ready = textOf((await DashboardPage({ params: Promise.resolve({ memorialId }) })) as Node);
    expect(ready).toContain('Watch the slideshow');
    expect(ready).toContain('A first version is ready');
  });
});
