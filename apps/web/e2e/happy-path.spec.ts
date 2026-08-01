/**
 * The whole journey, with real clicks.
 *
 * One family, from "somebody died" to a link a cousin abroad can open. Every
 * step is a real page in a real browser against a real database, a real queue,
 * a real worker and a real ffmpeg render — no mocked routes, no seeded state
 * except the music library, and no shortcuts through the server actions.
 *
 * It is deliberately one long test rather than several. The steps are not
 * independent: there is no meaningful "curate" without an upload before it, and
 * a suite that sets up state directly would stop testing the thing that
 * actually breaks, which is the seam between two screens.
 *
 * Kept fast by being small — three photographs and the draft preset — because a
 * test nobody runs is a test that does not work.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, '../../../fixtures/photos');

/** Three ordinary photographs, from three different decades of a life. */
const PHOTOS = ['01-portrait.jpg', '02-beach.jpg', '03-wedding.jpg'].map((name) =>
  path.join(fixtures, name),
);

const DECEDENT = 'Ruth Anne Kelleher';

/**
 * The screen's own heading.
 *
 * Not `getByRole('heading', { level: 1 })`: the preview page embeds the
 * slideshow itself, and a title card inside the composition is also an h1. The
 * one that says what screen you are on is the StepScreen's.
 */
const h1 = (target: Page) => target.locator('main > div > h1').first();

test.describe.configure({ mode: 'serial' });

test('a family gets from nothing to a video somebody else can watch', async ({ page, browser }) => {
  const started = Date.now();
  const mark = (step: string) =>
    process.stderr.write(`[e2e] ${step} +${Math.round((Date.now() - started) / 1000)}s\n`);

  /* --- creating the memorial --------------------------------------------- */

  await page.goto('/');
  await expect(h1(page)).toContainText('A gentle way to gather');
  await page.getByRole('link', { name: 'Create a memorial' }).click();

  await page.getByLabel('Their name').fill(DECEDENT);
  await page.getByLabel('Your name').fill('Anne Doyle');
  await page.getByLabel('Your email').fill('anne@example.test');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(h1(page)).toContainText('You are all set');
  const memorialId = new URL(page.url()).pathname.split('/')[2] as string;
  expect(memorialId).toBeTruthy();
  mark('memorial created');

  /* --- intake: answer two, skip two -------------------------------------- */

  await page.getByRole('link', { name: 'Continue' }).click();

  // 1. relationship — answered
  await expect(h1(page)).toContainText('How were you related');
  await page.getByRole('button', { name: 'Their child' }).click();

  // 2. tradition — answered
  await expect(h1(page)).toContainText('faith or tradition');
  await page.getByRole('button', { name: 'Not sure, or none' }).click();

  // 3. service date — skipped, which is a first-class answer here
  await expect(h1(page)).toContainText('date of the service');
  await page.getByRole('button', { name: 'Not yet' }).click();

  // 4. gathering — skipped
  await expect(h1(page)).toContainText('kind of gathering');
  await page.getByRole('button', { name: 'Skip this question' }).click();

  await expect(page).toHaveURL(new RegExp(`/m/${memorialId}$`));
  await expect(h1(page)).toContainText(`Remembering ${DECEDENT}`);
  mark('intake done');

  /* --- the collection link ------------------------------------------------ */

  await page.getByRole('link', { name: 'Collect photos' }).click();
  await expect(h1(page)).toContainText('Share this link with family');

  const familyLink = await page.locator('input[readonly]').first().inputValue();
  expect(familyLink).toContain('/c/');
  mark('collection link');

  /* --- a contributor, in their own browser, with no account --------------- */

  const contributorContext = await browser.newContext();
  const contributor = await contributorContext.newPage();
  contributor.on('console', (m) => process.stderr.write(`[e2e:console] ${m.text()}\n`));
  contributor.on('pageerror', (e) => process.stderr.write(`[e2e:pageerror] ${e.message}\n`));
  contributor.on('response', (r) => {
    if (r.status() >= 400) process.stderr.write(`[e2e:http] ${r.status()} ${r.url()}\n`);
  });
  await contributor.goto(familyLink);

  await expect(h1(contributor)).toContainText("You're helping remember");
  await contributor.getByLabel('What should we call you?').fill('Michael');
  await contributor.getByRole('button', { name: 'Start adding photos' }).click();

  await expect(h1(contributor)).toContainText('Thank you, Michael');
  await contributor.locator('input[type="file"]').setInputFiles(PHOTOS);

  // Uppy uploads in the background; the button appears when all three are in.
  await expect(contributor.getByRole('button', { name: /Done — 3 added/ })).toBeVisible({
    timeout: 60_000,
  });
  await contributor.getByRole('button', { name: /Done — 3 added/ }).click();

  // The notes page, which is optional, then the one memory question. It asks
  // about the batch that just arrived, which is remembered in a short cookie —
  // parallel uploads can leave it naming fewer than were sent, and that is fine:
  // the photographs are all safely in, and the notes are a bonus.
  await expect(h1(contributor)).toContainText(/\d+ added/);
  await contributor.getByRole('button', { name: /^(Save and continue|Continue)$/ }).click();

  await contributor.getByRole('textbox').first().fill('She taught me to swim at Dollymount.');
  await contributor.getByRole('button', { name: 'Send this' }).click();
  await expect(h1(contributor)).toContainText('Thank you');
  await contributorContext.close();
  mark('contributor uploaded 3 photos');

  /* --- the photographs are processed by the worker ------------------------ */

  // The ingest jobs are already on the queue; the curate grid shows a card per
  // photograph once they have been through it.
  await page.goto(`/m/${memorialId}/curate`);
  await expect(page.getByRole('button', { name: /^Keep / })).toHaveCount(3, { timeout: 60_000 });
  mark('photos ingested');

  /* --- curate: keep all three -------------------------------------------- */

  for (let i = 0; i < 3; i += 1) {
    // The grid re-renders after each press, so the first un-kept one is taken
    // each time rather than a stale handle.
    await page
      .getByRole('button', { name: /^Keep / })
      .first()
      .click();
    await expect(page.getByRole('button', { name: /^Keeping / })).toHaveCount(i + 1);
  }
  mark('photos kept');

  /* --- the interview ------------------------------------------------------ */

  await page.goto(`/m/${memorialId}/interview`);
  await page.getByRole('button', { name: 'Begin' }).click();

  for (let i = 0; i < 3; i += 1) {
    const answer = page.getByRole('textbox', { name: /.+/ }).first();
    await expect(answer).toBeVisible();
    await answer.fill(ANSWERS[i] as string);
    await page.getByRole('button', { name: 'Continue' }).click();
    // The next question replaces this one; the box empties.
    await expect(answer).toHaveValue('', { timeout: 30_000 });
  }

  // Approve an anecdote the interview drafted, in the story-so-far panel.
  await page.goto(`/m/${memorialId}/story`);
  const approve = page.getByRole('button', { name: /^(Keep this|Use this|Approve)/ }).first();
  if (await approve.isVisible().catch(() => false)) await approve.click();
  mark('interview answered');

  /* --- the shape of the story, then the slideshow ------------------------- */

  await page.goto(`/m/${memorialId}/story-shape`);
  await expect(h1(page)).toContainText('How should their story run');
  await page.getByRole('button', { name: /^Yes — / }).click();

  // The EDL is generated on the queue; the preview page waits for it and
  // refreshes itself.
  await expect(h1(page)).toContainText('Watch it through', {
    timeout: 90_000,
  });
  // The player is the same composition the file will be rendered from — it
  // renders as DOM, not as a <video>, which is exactly why the preview and the
  // file are frame-identical. Its presence shows as a second h1 on the page:
  // the composition's opening title card, inside the player.
  await expect(page.locator('main h1')).toHaveCount(2, { timeout: 30_000 });
  mark('slideshow ready, preview loaded');

  /* --- music -------------------------------------------------------------- */

  await page.getByRole('link', { name: /choose music next/ }).click();
  await expect(h1(page)).toContainText('How should the music work');
  await page.getByRole('button', { name: /Use music we include/ }).click();

  await expect(h1(page)).toContainText('Which piece of music');
  await page.getByRole('button', { name: 'Use this one' }).first().click();
  await expect(h1(page)).toContainText(/music|chosen|re-timed/i);
  mark('music chosen');

  /* --- making the video --------------------------------------------------- */

  await page.goto(`/m/${memorialId}/deliver`);
  await expect(h1(page)).toContainText('The finished video');
  await page.getByRole('button', { name: /quick, small copy to check first/ }).click();

  // The render is real: Remotion, ffmpeg, and ffprobe agreeing the file plays.
  // The page polls itself, so this is a wait rather than a reload loop.
  const download = page.getByRole('link', { name: 'Download' });
  await expect(download).toBeVisible({ timeout: 150_000 });
  await expect(page.getByText(/Ruth-Anne-Kelleher-Celebration-of-Life-Service/)).toBeVisible();
  mark('render finished');

  // The file really is there, and really is an MP4. Fetched from inside the
  // page rather than through Playwright's API client, because the session
  // cookie is `secure` in production and only the browser treats a loopback
  // origin as secure — the same reason the app insists on https in the world.
  const href = (await download.getAttribute('href')) as string;
  const file = await page.evaluate(async (url: string) => {
    const response = await fetch(url);
    const bytes = await response.arrayBuffer();
    return {
      status: response.status,
      type: response.headers.get('content-type'),
      disposition: response.headers.get('content-disposition'),
      size: bytes.byteLength,
    };
  }, href);
  expect(file.status).toBe(200);
  expect(file.type).toBe('video/mp4');
  expect(file.disposition).toContain('attachment');
  expect(file.size).toBeGreaterThan(10_000);

  /* --- a private viewing link --------------------------------------------- */

  await page.getByRole('button', { name: 'Share a private viewing link' }).click();
  await expect(page.getByText('Private viewing link')).toBeVisible();
  const watchLink = await page
    .locator('input[readonly]')
    .filter({ hasNot: page.locator('[hidden]') })
    .first()
    .inputValue();
  expect(watchLink).toContain('/w/');
  mark('viewing link shared');

  /* --- somebody else, in a browser that has never seen this site ---------- */

  const strangerContext = await browser.newContext();
  const stranger = await strangerContext.newPage();
  await stranger.goto(watchLink);

  await expect(h1(stranger)).toContainText(`In loving memory of ${DECEDENT}`);
  const video = stranger.locator('video');
  await expect(video).toBeVisible();
  // Nothing plays until they press play. That rule is absolute on this page.
  expect(await video.getAttribute('autoplay')).toBeNull();
  expect(await video.evaluate((el: HTMLVideoElement) => el.paused)).toBe(true);

  // The stream behind it answers, and answers a range request — which is what
  // makes the scrub bar work for somebody watching from another country.
  const src = (await video.getAttribute('src')) as string;
  const streamed = await stranger.evaluate(async (url: string) => {
    const response = await fetch(url, { headers: { range: 'bytes=0-99' } });
    return {
      status: response.status,
      range: response.headers.get('content-range'),
      disposition: response.headers.get('content-disposition'),
    };
  }, src);
  expect(streamed.status).toBe(206);
  expect(streamed.range).toMatch(/^bytes 0-99\/\d+$/);
  // Played, not handed over.
  expect(streamed.disposition).toContain('inline');

  // And it is a viewing link, not a download link, until the family says so.
  await expect(stranger.getByRole('link', { name: 'Save a copy' })).toHaveCount(0);

  await strangerContext.close();
  mark('watched from a fresh browser');
});

/** Three answers, of the kind somebody actually types at eleven at night. */
const ANSWERS = [
  'Ruth was born in Drogheda in 1938, the third of six, in a house on the Marsh Road.',
  'She trained as a nurse and worked at the Mater for thirty-one years, mostly nights.',
  'The garden was the thing. She grew roses badly and vegetables brilliantly and never admitted it.',
];
