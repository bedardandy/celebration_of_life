import { beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDb,
  insertOne,
  memorials,
  renderJobs,
  slideshowProjects,
  updateById,
  type Db,
} from '@col/db';
import type { RenderPreset } from '@col/schemas';
import {
  createWatchLink,
  ensureWatchLink,
  listWatchLinks,
  resolveWatchToken,
  revokeWatchLink,
  setWatchDownload,
  watchTokenAllows,
  watchableRender,
} from './links';

let db: Db;
let memorialId: string;
let otherMemorialId: string;

beforeEach(() => {
  process.env['APP_BASE_URL'] = 'https://example.test';
  db = createTestDb();
  memorialId = insertOne(db, memorials, { decedentName: 'Ruth Anne Kelleher' }).id;
  otherMemorialId = insertOne(db, memorials, { decedentName: 'Someone Else' }).id;
});

/** A finished render, as the worker would have left it. */
function finishedRender(
  forMemorialId: string,
  preset: RenderPreset,
  cut: 'service' | 'family' = 'service',
): string {
  const project = insertOne(db, slideshowProjects, { memorialId: forMemorialId } as never) as {
    id: string;
  };
  const job = insertOne(db, renderJobs, {
    memorialId: forMemorialId,
    projectId: project.id,
    cut,
    preset,
    status: 'done',
    progress: 1,
    outputBlobKey: `memorial/${forMemorialId}/render/${preset}.mp4`,
  } as never) as { id: string };
  return job.id;
}

/* -------------------------------------------------------------------------- */

describe('making a viewing link', () => {
  it('is shareable, scoped to watching, and shown again on demand', () => {
    const link = createWatchLink(db, { memorialId });

    expect(link.active).toBe(true);
    expect(link.allowDownload).toBe(false);
    expect(link.row.kind).toBe('watch');
    expect(link.row.scopes).toEqual(['watch']);
    expect(link.url).toBe(`https://example.test/w/${link.token}`);

    // Derived, not stored: the same link comes back next Thursday.
    const again = listWatchLinks(db, memorialId)[0];
    expect(again?.url).toBe(link.url);
  });

  it('never writes the plaintext into the database', () => {
    const link = createWatchLink(db, { memorialId });
    const rows = JSON.stringify(listWatchLinks(db, memorialId).map((l) => l.row));
    expect(link.token).toBeTruthy();
    expect(rows).not.toContain(link.token);
  });

  it('does not scatter links: one live one unless another is asked for', () => {
    const first = ensureWatchLink(db, memorialId);
    const second = ensureWatchLink(db, memorialId);
    expect(second.row.id).toBe(first.row.id);
    expect(listWatchLinks(db, memorialId)).toHaveLength(1);
  });

  it('has no expiry — the promise is that it keeps working', () => {
    const link = createWatchLink(db, { memorialId });
    expect(link.row.expiresAt).toBeNull();
    expect(link.row.maxUses).toBeNull();
  });
});

describe('turning it off', () => {
  it('closes the link without touching anything the family made', () => {
    const link = createWatchLink(db, { memorialId });
    expect(revokeWatchLink(db, memorialId, link.row.id)).toBe(true);

    const resolved = resolveWatchToken(db, link.token as string);
    expect(resolved.ok).toBe(false);
    expect(resolved.ok === false && resolved.reason).toBe('revoked');
  });

  it('refuses to revoke a link belonging to another family', () => {
    const link = createWatchLink(db, { memorialId });
    expect(revokeWatchLink(db, otherMemorialId, link.row.id)).toBe(false);
    expect(resolveWatchToken(db, link.token as string).ok).toBe(true);
  });
});

describe('whether people may keep a copy', () => {
  it('starts off, and is a toggle rather than a new link', () => {
    const link = createWatchLink(db, { memorialId });
    const token = link.token as string;

    const on = setWatchDownload(db, memorialId, link.row.id, true);
    expect(on?.allowDownload).toBe(true);
    // Same link — nothing has to be resent.
    expect(on?.token).toBe(token);

    const off = setWatchDownload(db, memorialId, link.row.id, false);
    expect(off?.allowDownload).toBe(false);
    expect(off?.token).toBe(token);
  });

  it('is not something another family can turn on', () => {
    const link = createWatchLink(db, { memorialId });
    expect(setWatchDownload(db, otherMemorialId, link.row.id, true)).toBeUndefined();
  });
});

describe('what a viewing link may reach', () => {
  it('sees its own memorial and never another one', () => {
    const mine = finishedRender(memorialId, 'final1080');
    const theirs = finishedRender(otherMemorialId, 'final1080');
    const link = createWatchLink(db, { memorialId });
    const token = link.token as string;

    const mineRow = db
      .select()
      .from(renderJobs)
      .all()
      .find((r) => r.id === mine);
    const theirsRow = db
      .select()
      .from(renderJobs)
      .all()
      .find((r) => r.id === theirs);

    expect(watchTokenAllows(db, token, mineRow as never)).toBe(true);
    expect(watchTokenAllows(db, token, theirsRow as never)).toBe(false);
  });

  it('may not download unless the family said so', () => {
    const renderId = finishedRender(memorialId, 'final1080');
    const link = createWatchLink(db, { memorialId });
    const token = link.token as string;
    const row = db
      .select()
      .from(renderJobs)
      .all()
      .find((r) => r.id === renderId) as never;

    expect(watchTokenAllows(db, token, row, { forDownload: true })).toBe(false);
    setWatchDownload(db, memorialId, link.row.id, true);
    expect(watchTokenAllows(db, token, row, { forDownload: true })).toBe(true);
  });

  it('reaches nothing at all once revoked', () => {
    const renderId = finishedRender(memorialId, 'final1080');
    const link = createWatchLink(db, { memorialId });
    const token = link.token as string;
    const row = db
      .select()
      .from(renderJobs)
      .all()
      .find((r) => r.id === renderId) as never;

    revokeWatchLink(db, memorialId, link.row.id);
    expect(watchTokenAllows(db, token, row)).toBe(false);
  });
});

describe('which video a viewing link plays', () => {
  it('prefers the full-quality file over the backup and the draft', () => {
    finishedRender(memorialId, 'draft360');
    finishedRender(memorialId, 'backup720');
    const final = finishedRender(memorialId, 'final1080');
    expect(watchableRender(db, memorialId)?.id).toBe(final);
  });

  it('falls back to a draft rather than showing nothing', () => {
    const draft = finishedRender(memorialId, 'draft360');
    expect(watchableRender(db, memorialId)?.id).toBe(draft);
  });

  it('ignores a render that has not finished', () => {
    const id = finishedRender(memorialId, 'final1080');
    updateById(db, renderJobs, id, { status: 'running', outputBlobKey: null });
    expect(watchableRender(db, memorialId)).toBeUndefined();
  });

  it('says there is nothing to watch when nothing has been made', () => {
    const link = createWatchLink(db, { memorialId });
    const resolved = resolveWatchToken(db, link.token as string);
    expect(resolved.ok).toBe(true);
    expect(resolved.ok && resolved.context.render).toBeUndefined();
  });
});

describe('opening a viewing link', () => {
  it('hands back the memorial and the video without consuming a use', () => {
    finishedRender(memorialId, 'final1080');
    const link = createWatchLink(db, { memorialId });
    const token = link.token as string;

    const first = resolveWatchToken(db, token);
    const second = resolveWatchToken(db, token);
    expect(first.ok && first.context.memorial.decedentName).toBe('Ruth Anne Kelleher');
    expect(second.ok).toBe(true);
    expect(second.ok && second.context.render).toBeDefined();
  });

  it('will not open a memorial that has been removed', () => {
    const link = createWatchLink(db, { memorialId });
    updateById(db, memorials, memorialId, { deletedAt: Date.now() });
    const resolved = resolveWatchToken(db, link.token as string);
    expect(resolved.ok === false && resolved.reason).toBe('gone');
  });

  it('turns away a link that was never one of ours', () => {
    const resolved = resolveWatchToken(db, 'not-a-real-token-at-all-000000');
    expect(resolved.ok === false && resolved.reason).toBe('not-found');
  });
});
