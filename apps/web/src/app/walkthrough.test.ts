/**
 * The walkthrough, headless.
 *
 * Create a memorial → get the link → be signed in → answer some intake
 * questions → close the tab halfway → come back through the link → land where
 * you left off → finish → see the dashboard. If any of that stops working, a
 * family loses their afternoon, so it is checked on every run.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const workdir = mkdtempSync(path.join(tmpdir(), 'col-web-test-'));
process.env['DATABASE_URL'] = `file:${path.join(workdir, 'walkthrough.db')}`;
process.env['SESSION_SECRET'] = 'walkthrough-test-secret';
process.env['APP_BASE_URL'] = 'http://localhost:3000';
// Vitest runs with NODE_ENV=test, so this is not production and the dev link is
// handed back to the screen that shows it. That is the behaviour under test.

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
const { requestLinkAction } = await import('./resume/actions');
const { answerStepAction, saveServiceDateAction } = await import('./m/[memorialId]/intake/actions');
const { removeMemorialAction, restoreMemorialAction } = await import('./m/[memorialId]/actions');
const { GET: redeem } = await import('./auth/[token]/route');
const { DEV_LINK_COOKIE } = await import('@/server/session');
const {
  DevConsoleTransport,
  SESSION_COOKIE,
  computeChecklist,
  dashboardBanner,
  decodeSession,
  resumeIntakeStep,
  setMailTransport,
} = await import('@col/core');
const { getById, memorials } = await import('@col/db');

afterAll(() => {
  setMailTransport(undefined);
  rmSync(workdir, { recursive: true, force: true });
});

beforeAll(() => {
  // Same transport, without a hundred lines of link spam in the test output.
  setMailTransport(new DevConsoleTransport(() => {}));
  // Touch the database once so the first test is not also the migration.
  db();
});

beforeEach(() => {
  cookieJar.clear();
});

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

async function createMemorial(decedentName = 'Ruth Kelleher') {
  const destination = await captureRedirect(() =>
    createMemorialAction(
      {},
      form({
        decedentName,
        organizerName: 'Anne Kelleher',
        organizerEmail: `anne+${Math.random().toString(36).slice(2)}@example.test`,
      }),
    ),
  );
  const memorialId = destination.split('/')[2] as string;
  const link = cookieJar.get(DEV_LINK_COOKIE)?.value as string;
  return { memorialId, destination, link, token: link?.split('/').pop() as string };
}

function reload(memorialId: string) {
  const row = getById(db(), memorials, memorialId);
  if (!row) throw new Error('memorial vanished');
  return row;
}

describe('creating a memorial', () => {
  it('signs the organizer in and shows them the link, in development', async () => {
    const { memorialId, destination, link } = await createMemorial();

    expect(destination).toBe(`/m/${memorialId}/created`);
    expect(link).toMatch(/^http:\/\/localhost:3000\/auth\/[A-Za-z0-9_-]{43}$/);

    const cookie = cookieJar.get(SESSION_COOKIE);
    expect(cookie).toBeDefined();
    expect(cookie?.options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });

    const session = decodeSession(cookie?.value);
    expect(session).toMatchObject({ memorialId, role: 'organizer' });
  });

  it('asks again, kindly, when a field is missing', async () => {
    const result = await createMemorialAction(
      {},
      form({ decedentName: '', organizerName: 'Anne', organizerEmail: 'anne@example.test' }),
    );
    expect(result.field).toBe('decedentName');
    expect(result.error).toMatch(/their name/i);
    // What they already typed comes back with them.
    expect(result.values?.organizerName).toBe('Anne');
    expect(cookieJar.get(SESSION_COOKIE)).toBeUndefined();
  });
});

describe('the magic link', () => {
  it('is exchanged for an httpOnly session cookie and a redirect', async () => {
    const { memorialId, token } = await createMemorial();
    cookieJar.clear();

    const response = await redeem(new Request(`http://localhost:3000/auth/${token}`), {
      params: Promise.resolve({ token }),
    });

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      `http://localhost:3000/m/${memorialId}/intake/relationship`,
    );

    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie.toLowerCase()).toContain('httponly');
    expect(setCookie.toLowerCase()).toContain('samesite=lax');

    const value = decodeURIComponent(setCookie.split(';')[0]?.split('=')[1] ?? '');
    expect(decodeSession(value)).toMatchObject({ memorialId, role: 'organizer' });
  });

  it('works only once, and says so without blaming anyone', async () => {
    const { token } = await createMemorial();
    const first = await redeem(new Request(`http://localhost:3000/auth/${token}`), {
      params: Promise.resolve({ token }),
    });
    expect(first.status).toBe(307);

    const second = await redeem(new Request(`http://localhost:3000/auth/${token}`), {
      params: Promise.resolve({ token }),
    });
    expect(second.headers.get('location')).toBe('http://localhost:3000/resume?reason=link-used');
    expect(second.headers.get('set-cookie')).toBeNull();
  });

  it('refuses a tampered token', async () => {
    const { token } = await createMemorial();
    const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    const response = await redeem(new Request(`http://localhost:3000/auth/${tampered}`), {
      params: Promise.resolve({ token: tampered }),
    });
    expect(response.headers.get('location')).toBe('http://localhost:3000/resume?reason=signed-out');
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('refuses nonsense in the URL', async () => {
    for (const token of ['', 'x', 'not-a-real-token-at-all']) {
      const response = await redeem(new Request(`http://localhost:3000/auth/${token}`), {
        params: Promise.resolve({ token }),
      });
      expect(response.headers.get('location')).toContain('/resume');
      expect(response.headers.get('set-cookie')).toBeNull();
    }
  });

  it('can be re-issued from the front page when the first one is spent', async () => {
    const data = new FormData();
    data.append('decedentName', 'Ruth Kelleher');
    data.append('organizerName', 'Anne Kelleher');
    data.append('organizerEmail', 'resume-me@example.test');
    await captureRedirect(() => createMemorialAction({}, data));
    cookieJar.clear();

    const destination = await captureRedirect(() =>
      requestLinkAction({}, form({ email: 'resume-me@example.test' })),
    );
    expect(destination).toBe('/resume/sent');

    const link = cookieJar.get(DEV_LINK_COOKIE)?.value as string;
    const token = link.split('/').pop() as string;
    const response = await redeem(new Request(link), { params: Promise.resolve({ token }) });
    expect(response.status).toBe(307);
  });

  it('gives an unknown address the same answer as a known one', async () => {
    const destination = await captureRedirect(() =>
      requestLinkAction({}, form({ email: 'nobody-here@example.test' })),
    );
    expect(destination).toBe('/resume/sent');
    expect(cookieJar.get(DEV_LINK_COOKIE)).toBeUndefined();
  });
});

describe('the intake wizard', () => {
  it('writes each answer as it is given and moves to the next question', async () => {
    const { memorialId } = await createMemorial();

    const afterRelationship = await captureRedirect(() =>
      answerStepAction(form({ memorialId, step: 'relationship', value: 'child' })),
    );
    expect(afterRelationship).toBe(`/m/${memorialId}/intake/tradition`);
    expect(reload(memorialId).organizerRelationship).toBe('child');

    const afterTradition = await captureRedirect(() =>
      answerStepAction(form({ memorialId, step: 'tradition', value: 'catholic' })),
    );
    expect(afterTradition).toBe(`/m/${memorialId}/intake/service-date`);
    expect(reload(memorialId).traditionSlug).toBe('catholic');
    expect(reload(memorialId).pacingPreset).toBe('days3to7');
  });

  it('keeps everything when the tab is closed halfway, and resumes there', async () => {
    const { memorialId, token } = await createMemorial();
    await captureRedirect(() =>
      answerStepAction(form({ memorialId, step: 'relationship', value: 'spouse-partner' })),
    );
    await captureRedirect(() =>
      answerStepAction(form({ memorialId, step: 'tradition', value: 'secular' })),
    );

    // The tab is closed. Everything the browser knew is gone.
    cookieJar.clear();

    const response = await redeem(new Request(`http://localhost:3000/auth/${token}`), {
      params: Promise.resolve({ token }),
    });
    expect(response.headers.get('location')).toBe(
      `http://localhost:3000/m/${memorialId}/intake/service-date`,
    );

    const resumed = reload(memorialId);
    expect(resumed.organizerRelationship).toBe('spouse-partner');
    expect(resumed.traditionSlug).toBe('secular');
    expect(resumeIntakeStep(resumed)).toBe('service-date');
  });

  it('autosaves the service date without a Save button, and Continue keeps it', async () => {
    const { memorialId } = await createMemorial();
    await captureRedirect(() =>
      answerStepAction(form({ memorialId, step: 'relationship', value: '' })),
    );
    await captureRedirect(() =>
      answerStepAction(form({ memorialId, step: 'tradition', value: 'secular' })),
    );

    await saveServiceDateAction({
      memorialId,
      date: '2026-08-02',
      time: '14:00',
      timezone: 'Europe/Dublin',
    });
    const saved = reload(memorialId).serviceDate;
    expect(saved).toBe(Date.UTC(2026, 7, 2, 13, 0));

    const next = await captureRedirect(() =>
      answerStepAction(form({ memorialId, step: 'service-date', value: 'keep' })),
    );
    expect(next).toBe(`/m/${memorialId}/intake/gathering`);
    expect(reload(memorialId).serviceDate).toBe(saved);
  });

  it('lets every question be skipped, and still finishes', async () => {
    const { memorialId } = await createMemorial();
    for (const stepName of ['relationship', 'tradition', 'service-date'] as const) {
      await captureRedirect(() =>
        answerStepAction(form({ memorialId, step: stepName, value: '' })),
      );
    }
    const done = await captureRedirect(() =>
      answerStepAction(form({ memorialId, step: 'gathering', value: '' })),
    );

    expect(done).toBe(`/m/${memorialId}`);
    const finished = reload(memorialId);
    expect(finished.status).toBe('active');
    expect(finished.intakeCompletedAt).not.toBeNull();
    expect(finished.serviceDate).toBeNull();
    expect(resumeIntakeStep(finished)).toBeUndefined();
  });

  it('refuses to answer for a memorial the session does not belong to', async () => {
    const mine = await createMemorial('Ruth Kelleher');
    const theirs = await createMemorial('Someone Else');
    // The second create left us signed in to `theirs`.
    const destination = await captureRedirect(() =>
      answerStepAction(form({ memorialId: mine.memorialId, step: 'relationship', value: 'child' })),
    );
    expect(destination).toBe('/');
    expect(reload(mine.memorialId).organizerRelationship).toBeNull();
    expect(theirs.memorialId).not.toBe(mine.memorialId);
  });
});

describe('the dashboard', () => {
  it('greets a brand new memorial with a calm banner and three cards', async () => {
    const { memorialId } = await createMemorial();
    const memorial = reload(memorialId);

    const checklist = computeChecklist(memorial, { photos: 0, memories: 0 });
    const banner = dashboardBanner({
      pacingPreset: memorial.pacingPreset,
      serviceDate: memorial.serviceDate,
      nextStep: checklist.nextStep,
    });

    expect(checklist.cards.map((c) => c.title)).toEqual([
      'Collect photos',
      'Tell their story',
      'Build the slideshow',
    ]);
    expect(checklist.cards[2]?.state).toBe('locked');
    expect(banner.headline).toBe('No date yet, so there is no rush.');
    expect(banner.nextStep).toBe('The most helpful next step is gathering a few photos.');
  });

  it('turns urgent, without alarm, once the service is tomorrow', async () => {
    const { memorialId } = await createMemorial();
    await captureRedirect(() =>
      answerStepAction(form({ memorialId, step: 'relationship', value: 'child' })),
    );
    await captureRedirect(() =>
      answerStepAction(form({ memorialId, step: 'tradition', value: 'secular' })),
    );

    const tomorrow = new Date(Date.now() + 20 * 60 * 60 * 1000);
    await saveServiceDateAction({
      memorialId,
      date: tomorrow.toISOString().slice(0, 10),
      time: `${String(tomorrow.getUTCHours()).padStart(2, '0')}:00`,
      timezone: 'UTC',
    });

    const memorial = reload(memorialId);
    expect(memorial.pacingPreset).toBe('urgent24h');

    const checklist = computeChecklist(memorial, { photos: 0, memories: 0 });
    const banner = dashboardBanner({
      pacingPreset: memorial.pacingPreset,
      serviceDate: memorial.serviceDate,
      nextStep: checklist.nextStep,
    });
    expect(banner.tone).toBe('urgent');
    expect(banner.headline).toBe('The service is tomorrow.');
    expect(banner.nextStep).toBe('The most helpful next step is gathering a few photos.');
    expect(banner.headline).not.toMatch(/!/);
  });
});

describe('removing a memorial', () => {
  it('leaves a tombstone and can be undone', async () => {
    const { memorialId } = await createMemorial();

    const { message } = await removeMemorialAction(memorialId);
    expect(message).toBe('Removed. Nothing is deleted yet.');
    expect(reload(memorialId).deletedAt).not.toBeNull();

    await restoreMemorialAction(memorialId);
    expect(reload(memorialId).deletedAt).toBeNull();
  });

  it('cannot be done by a session for another memorial', async () => {
    const mine = await createMemorial('Ruth Kelleher');
    await createMemorial('Someone Else');
    const destination = await captureRedirect(() => removeMemorialAction(mine.memorialId));
    expect(destination).toBe('/');
    expect(reload(mine.memorialId).deletedAt).toBeNull();
  });
});
