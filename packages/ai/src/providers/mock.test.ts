import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PhotoAnalysisBatchSchema } from '@col/schemas';
import { z } from 'zod';
import { clearFixtureCache, fixtureKey, findFixture, fixturesDir } from '../fixtures';
import { REPAIR_MARKER } from '../generate-object';
import { assetLine } from '../prompts/photo-analysis';
import { ECHO_PREFIX, resetMockState, resolveMockResponse } from './mock';

const dirs: string[] = [];
function fixtureTree(files: Record<string, unknown>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'col-ai-fixtures-'));
  dirs.push(root);
  for (const [relative, body] of Object.entries(files)) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(body, null, 2));
  }
  clearFixtureCache();
  return root;
}

beforeEach(() => {
  resetMockState();
  clearFixtureCache();
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe('fixture lookup', () => {
  it('matches on a substring of the request, ignoring case and reflow', () => {
    const dir = fixtureTree({
      'interview/01.json': { id: '01', match: 'the dahlias', response: 'first' },
    });
    expect(findFixture('interview', 'They answered: THE   DAHLIAS, mostly.', dir)?.id).toBe('01');
  });

  it('prefers a case pinned by hash over any substring match', () => {
    const text = 'the dahlias';
    const dir = fixtureTree({
      'interview/00-loose.json': { id: '00-loose', match: 'dahlia', response: 'loose' },
      'interview/pinned.json': { id: fixtureKey(text), response: 'pinned' },
    });
    expect(findFixture('interview', text, dir)?.response).toBe('pinned');
  });

  it('serves earlier file names first', () => {
    const dir = fixtureTree({
      'interview/01.json': { id: '01', match: 'garden', response: 'first' },
      'interview/02.json': { id: '02', match: 'garden', response: 'second' },
    });
    expect(findFixture('interview', 'the garden', dir)?.response).toBe('first');
  });

  it('falls back to default.json, then to nothing', () => {
    const dir = fixtureTree({
      'interview/default.json': { id: 'default', response: 'fallback' },
    });
    expect(findFixture('interview', 'anything at all', dir)?.response).toBe('fallback');
    expect(findFixture('curation', 'anything at all', dir)).toBeUndefined();
  });

  it('reads AI_FIXTURES_DIR', () => {
    expect(fixturesDir({ AI_FIXTURES_DIR: '/somewhere/else' })).toBe('/somewhere/else');
    expect(fixturesDir({})).toMatch(/fixtures[\\/]ai$/);
  });
});

describe('the mock provider', () => {
  it('serves a canned string', () => {
    const dir = fixtureTree({
      'interview/01.json': { id: '01', match: 'the dahlias', response: 'Which ones?' },
    });
    const resolution = resolveMockResponse(
      { messages: [{ role: 'user', content: 'the dahlias, mostly' }], taskTag: 'interview' },
      dir,
    );
    expect(resolution).toMatchObject({ text: 'Which ones?', source: 'fixture', fixtureId: '01' });
  });

  it('serialises an object response, so fixtures stay readable', () => {
    const dir = fixtureTree({
      'interview/01.json': { id: '01', match: 'garden', response: { a: 1 } },
    });
    const resolution = resolveMockResponse(
      { messages: [{ role: 'user', content: 'the garden' }], taskTag: 'interview' },
      dir,
    );
    expect(JSON.parse(resolution.text)).toEqual({ a: 1 });
  });

  it('walks a scripted sequence, then stays on the last entry', () => {
    const dir = fixtureTree({
      'interview/01.json': { id: '01', match: 'garden', responses: ['one', 'two'] },
    });
    const request = {
      messages: [{ role: 'user' as const, content: 'the garden' }],
      taskTag: 'interview',
    };
    expect(resolveMockResponse(request, dir).text).toBe('one');
    expect(resolveMockResponse(request, dir).text).toBe('two');
    expect(resolveMockResponse(request, dir).text).toBe('two');
  });

  it('starts a scripted sequence over after resetMockState', () => {
    const dir = fixtureTree({
      'interview/01.json': { id: '01', match: 'garden', responses: ['one', 'two'] },
    });
    const request = {
      messages: [{ role: 'user' as const, content: 'the garden' }],
      taskTag: 'interview',
    };
    expect(resolveMockResponse(request, dir).text).toBe('one');
    resetMockState();
    expect(resolveMockResponse(request, dir).text).toBe('one');
  });

  it('resolves a repair turn back to the case that produced the broken output', () => {
    const dir = fixtureTree({
      'interview/01.json': { id: '01', match: 'garden', responses: ['{broken', 'fixed'] },
    });
    const first = resolveMockResponse(
      { messages: [{ role: 'user', content: 'the garden' }], taskTag: 'interview' },
      dir,
    );
    expect(first.text).toBe('{broken');

    const repaired = resolveMockResponse(
      {
        messages: [
          { role: 'user', content: 'the garden' },
          { role: 'assistant', content: '{broken' },
          { role: 'user', content: `${REPAIR_MARKER} that was not valid JSON` },
        ],
        taskTag: 'interview',
      },
      dir,
    );
    expect(repaired.text).toBe('fixed');
  });

  it('synthesises from the schema when nothing matches', () => {
    const dir = fixtureTree({ 'other/01.json': { id: '01', response: 'x' } });
    const schema = z.object({ name: z.string(), tags: z.array(z.string()) }).strict();
    const resolution = resolveMockResponse(
      {
        messages: [{ role: 'user', content: 'no fixture for this' }],
        taskTag: 'interview',
        jsonSchema: z.toJSONSchema(schema) as Record<string, unknown>,
      },
      dir,
    );
    expect(resolution.source).toBe('schema');
    expect(schema.safeParse(JSON.parse(resolution.text)).success).toBe(true);
  });

  it('still echoes when there is no fixture and no schema', () => {
    const dir = fixtureTree({});
    const resolution = resolveMockResponse({ messages: [{ role: 'user', content: 'hello' }] }, dir);
    expect(resolution.text).toBe(`${ECHO_PREFIX}hello`);
  });
});

describe('the mock and photo batches', () => {
  const assets = [
    { id: 'asset-a', path: '/blobs/memorial/m1/variant/web1600/04-garden.jpg' },
    { id: 'asset-b', path: '/blobs/memorial/m1/variant/web1600/06-blurry.jpg' },
  ];
  const prompt = [
    'Analyse the images at these paths:',
    ...assets.map((a) => assetLine(a.id, a.path)),
  ].join('\n');

  it('returns one entry per asset id, keyed by the file name', () => {
    const dir = fixtureTree({
      'photo-analysis/04-garden.json': {
        id: '04-garden',
        match: '04-garden.jpg',
        images: { '04-garden.jpg': analysis('a woman kneeling by a flower bed', 0.95) },
      },
      'photo-analysis/default.json': {
        id: 'default',
        response: analysis('an unsorted photograph', 0.5),
      },
    });

    const resolution = resolveMockResponse(
      {
        messages: [{ role: 'user', content: prompt }],
        taskTag: 'photo-analysis',
        jsonSchema: schemaFor(),
      },
      dir,
    );
    expect(resolution.source).toBe('photo-batch');

    const parsed = PhotoAnalysisBatchSchema.parse(JSON.parse(resolution.text));
    expect(parsed.analyses.map((entry) => entry.assetId)).toEqual(['asset-a', 'asset-b']);
    expect(parsed.analyses[0]?.analysis.description).toContain('kneeling');
    // No canned case for the blurry one, so the default stands in.
    expect(parsed.analyses[1]?.analysis.description).toContain('unsorted');
  });

  it('synthesises a valid analysis for a photo with no fixture at all', () => {
    const dir = fixtureTree({});
    const resolution = resolveMockResponse(
      {
        messages: [{ role: 'user', content: prompt }],
        taskTag: 'photo-analysis',
        jsonSchema: schemaFor(),
      },
      dir,
    );
    const parsed = PhotoAnalysisBatchSchema.safeParse(JSON.parse(resolution.text));
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
  });

  it('uses the committed fixtures when pointed at the real directory', () => {
    const resolution = resolveMockResponse({
      messages: [{ role: 'user', content: prompt }],
      taskTag: 'photo-analysis',
      jsonSchema: schemaFor(),
    });
    const parsed = PhotoAnalysisBatchSchema.parse(JSON.parse(resolution.text));
    expect(parsed.analyses[0]?.analysis.description).toMatch(/kneeling/i);
    expect(parsed.analyses[1]?.analysis.slideSuitability).toBeLessThan(0.3);
  });
});

function schemaFor(): Record<string, unknown> {
  return z.toJSONSchema(PhotoAnalysisBatchSchema) as Record<string, unknown>;
}

function analysis(description: string, slideSuitability: number) {
  return {
    description,
    settingTags: ['garden'],
    emotionalTone: 'absorbed',
    slideSuitability,
  };
}
