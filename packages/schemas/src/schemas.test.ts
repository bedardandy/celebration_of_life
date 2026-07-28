import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EdlSchema,
  JobPayloadSchema,
  JobPayloadSchemas,
  JOB_TYPES,
  LifeStoryDocumentSchema,
  PhotoAnalysisSchema,
  parseJobPayload,
} from './index';

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const load = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(fixtureDir, name), 'utf8'));

/**
 * "Round-trip" = the fixture parses, and the *parsed output* (defaults applied,
 * unknown keys rejected) parses again to an identical value. That is what makes
 * these schemas safe to use as a storage format.
 */
function roundTrip<T>(schema: { parse: (v: unknown) => T }, raw: unknown): T {
  const once = schema.parse(raw);
  const twice = schema.parse(JSON.parse(JSON.stringify(once)));
  expect(twice).toEqual(once);
  return once;
}

describe('EdlSchema', () => {
  it('round-trips the fixture EDL', () => {
    const edl = roundTrip(EdlSchema, load('edl.json'));
    expect(edl.version).toBe(1);
    expect(Object.keys(edl.slides)).toHaveLength(4);
    expect(edl.chapters.flatMap((c) => c.slideIds)).toHaveLength(4);
  });

  it('discriminates slide kinds', () => {
    const edl = EdlSchema.parse(load('edl.json'));
    const title = edl.slides['s-title'];
    expect(title?.kind).toBe('title');
    const photo = edl.slides['s-photo-1'];
    if (photo?.kind !== 'photo') throw new Error('expected a photo slide');
    expect(photo.kenBurns.easing).toBe('easeInOut');
    expect(photo.caption?.position).toBe('lower-third');
  });

  it('rejects a chapter that references a slide id that does not exist', () => {
    const raw = load('edl.json') as any;
    raw.chapters[0].slideIds = ['s-does-not-exist'];
    const result = EdlSchema.safeParse(raw);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('unknown slide id');
  });

  it('rejects unknown keys (strict) and out-of-range Ken Burns rects', () => {
    const withExtra = load('edl.json') as any;
    withExtra.somethingNew = true;
    expect(EdlSchema.safeParse(withExtra).success).toBe(false);

    const badRect = load('edl.json') as any;
    badRect.slides['s-photo-1'].kenBurns.from.w = 1.4;
    expect(EdlSchema.safeParse(badRect).success).toBe(false);
  });
});

describe('LifeStoryDocumentSchema', () => {
  it('round-trips the fixture document', () => {
    const doc = roundTrip(LifeStoryDocumentSchema, load('life-story-document.json'));
    expect(doc.subject.knownAs).toBe('Peggy');
    expect(doc.chapters).toHaveLength(2);
    expect(doc.coveragePhotoGaps.length).toBeGreaterThan(0);
  });

  it('keeps AI drafts explicitly unapproved', () => {
    const doc = LifeStoryDocumentSchema.parse(load('life-story-document.json'));
    const drafts = doc.chapters.flatMap((c) => c.anecdotes).filter((a) => a.source === 'ai-draft');
    expect(drafts.length).toBeGreaterThan(0);
    expect(drafts.every((a) => a.approved === false)).toBe(true);
  });

  it('requires an approved flag on every anecdote', () => {
    const raw = load('life-story-document.json') as any;
    delete raw.chapters[0].anecdotes[0].approved;
    expect(LifeStoryDocumentSchema.safeParse(raw).success).toBe(false);
  });
});

describe('PhotoAnalysisSchema', () => {
  it('round-trips the fixture analysis', () => {
    const analysis = roundTrip(PhotoAnalysisSchema, load('photo-analysis.json'));
    expect(analysis.slideSuitability).toBeGreaterThan(0);
    expect(analysis.slideSuitability).toBeLessThanOrEqual(1);
  });

  it('bounds slideSuitability to 0..1', () => {
    const raw = load('photo-analysis.json') as any;
    raw.slideSuitability = 1.5;
    expect(PhotoAnalysisSchema.safeParse(raw).success).toBe(false);
  });
});

describe('job payloads', () => {
  const payloads = load('job-payloads.json') as unknown[];

  it('has a fixture for every declared job type', () => {
    const seen = payloads.map((p) => (p as { type: string }).type).sort();
    expect(seen).toEqual([...JOB_TYPES].sort());
  });

  it('round-trips every job payload through the discriminated union', () => {
    for (const raw of payloads) {
      const parsed = roundTrip(JobPayloadSchema, raw);
      expect(JobPayloadSchemas[parsed.type]).toBeDefined();
    }
  });

  it('applies payload defaults', () => {
    const noop = JobPayloadSchema.parse({ type: 'noop' });
    expect(noop).toEqual({ type: 'noop', sleepMs: 100 });
  });

  it('parseJobPayload cross-checks the row type against the payload type', () => {
    expect(parseJobPayload('noop', { type: 'noop' }).type).toBe('noop');
    expect(() => parseJobPayload('render', { type: 'noop' })).toThrow(/does not match row type/);
  });

  it('rejects an unknown job type', () => {
    expect(JobPayloadSchema.safeParse({ type: 'launch-rocket' }).success).toBe(false);
  });
});
