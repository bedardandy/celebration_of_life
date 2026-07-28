import { describe, expect, it } from 'vitest';
import { TraditionPackSchema } from '@col/schemas';
import {
  DEFAULT_TRADITION_SLUG,
  TRADITION_SLUGS,
  TraditionPackError,
  UnknownTraditionError,
  getDefaultPack,
  getPack,
  hasPack,
  listPacks,
  parsePack,
} from './index';

describe('tradition packs in this repo', () => {
  it('ships the three Phase 0 packs', () => {
    expect([...TRADITION_SLUGS]).toEqual(['catholic', 'jewish', 'secular']);
  });

  it('every pack parses against TraditionPackSchema', () => {
    const packs = listPacks();
    expect(packs).toHaveLength(TRADITION_SLUGS.length);
    for (const pack of packs) {
      expect(() => TraditionPackSchema.parse(pack)).not.toThrow();
      expect(pack.mediaPlacement.length).toBeGreaterThan(0);
      expect(pack.musicGuidance.length).toBeGreaterThan(0);
      expect(pack.serviceTimelineNote.trim()).not.toBe('');
    }
  });

  it('carries the pacing preset each tradition implies', () => {
    expect(getPack('secular').pacingPreset).toBe('flexible');
    expect(getPack('catholic').pacingPreset).toBe('days3to7');
    expect(getPack('jewish').pacingPreset).toBe('urgent24h');
  });

  it('says where media belongs, in plain language', () => {
    const catholic = getPack('catholic');
    const mass = catholic.mediaPlacement.find((p) => /Mass/.test(p.context));
    expect(mass?.guidance).toMatch(/parish/i);

    const jewish = getPack('jewish');
    expect(jewish.mediaPlacement.map((p) => p.context).join(' ')).toMatch(/shiva/i);
  });

  it('defaults to the least presumptuous pack', () => {
    expect(DEFAULT_TRADITION_SLUG).toBe('secular');
    expect(getDefaultPack().slug).toBe('secular');
  });
});

describe('lookup errors', () => {
  it('names the packs that do exist when a slug is unknown', () => {
    expect(hasPack('klingon')).toBe(false);
    expect(() => getPack('klingon')).toThrow(UnknownTraditionError);
    expect(() => getPack('klingon')).toThrow(/Available: catholic, jewish, secular/);
  });
});

describe('parsePack', () => {
  it('names the pack when the JSON is malformed', () => {
    expect(() => parsePack('broken.json', '{ nope')).toThrow(TraditionPackError);
    expect(() => parsePack('broken.json', '{ nope')).toThrow(/"broken.json": is not valid JSON/);
  });

  it('names the pack and the failing field when validation fails', () => {
    const bad = JSON.stringify({ slug: 'oops', label: 'Oops' });
    expect(() => parsePack('oops.json', bad)).toThrow(/"oops.json": failed validation/);
    expect(() => parsePack('oops.json', bad)).toThrow(/pacingPreset/);
  });

  it('insists the file name matches the slug', () => {
    const pack = { ...getPack('secular'), slug: 'secular' };
    expect(() => parsePack('other.json', JSON.stringify(pack))).toThrow(
      /file name must match the slug/,
    );
  });
});
