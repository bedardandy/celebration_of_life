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
  it('ships a pack for each tradition we have written for', () => {
    expect([...TRADITION_SLUGS]).toEqual([
      'buddhist',
      'catholic',
      'hindu',
      'homegoing',
      'jewish',
      'muslim',
      'orthodox-christian',
      'protestant',
      'secular',
    ]);
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

  it('carries the pacing preset the new packs imply', () => {
    expect(getPack('muslim').pacingPreset).toBe('urgent24h');
    expect(getPack('hindu').pacingPreset).toBe('memorial-cycle');
    expect(getPack('buddhist').pacingPreset).toBe('memorial-cycle');
    expect(getPack('orthodox-christian').pacingPreset).toBe('days3to7');
    expect(getPack('protestant').pacingPreset).toBe('days3to7');
    expect(getPack('homegoing').pacingPreset).toBe('flexible');
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

  it('is honest that norms vary, wherever a family might otherwise be misled', () => {
    expect(getPack('muslim').serviceTimelineNote).toMatch(/varies|vary/i);
    expect(getPack('hindu').serviceTimelineNote).toMatch(/differ|vary|varies/i);
    expect(getPack('buddhist').serviceTimelineNote).toMatch(/varies|vary/i);
    expect(
      getPack('protestant')
        .mediaPlacement.map((p) => p.guidance)
        .join(' '),
    ).toMatch(/varies from congregation/i);
  });

  it('says plainly where media does not belong', () => {
    const janazah = getPack('muslim').mediaPlacement.find((p) => /janazah/i.test(p.context));
    expect(janazah?.guidance).toMatch(/no music|no slideshow|no screen/i);

    const orthodox = getPack('orthodox-christian');
    expect(orthodox.musicGuidance.join(' ')).toMatch(/a cappella|voices alone/i);
  });

  it('treats the homegoing program as the keepsake it is', () => {
    const program = getPack('homegoing').mediaPlacement.find((p) => /program/i.test(p.context));
    expect(program?.guidance).toMatch(/keepsake/i);
  });

  /* -- the printed program ------------------------------------------------- */

  it('gives every pack an order of service and readings', () => {
    for (const pack of listPacks()) {
      expect(pack.orderOfService.length, `${pack.slug} orderOfService`).toBeGreaterThan(0);
      expect(pack.readings.length, `${pack.slug} readings`).toBeGreaterThan(0);
      for (const item of pack.orderOfService) expect(item.item.trim()).not.toBe('');
      for (const reading of pack.readings) {
        expect(reading.title.trim()).not.toBe('');
        expect(reading.source.trim()).not.toBe('');
      }
    }
  });

  /**
   * Reproducing a text still in copyright inside a funeral program is a real
   * legal problem for a family that has enough on. Anything we print carries a
   * provenance line saying why we may; anything we may not is named only.
   */
  it('only reproduces readings whose provenance is stated', () => {
    const provenance = /public domain|traditional|plain english rendering|transliteration/i;
    for (const pack of listPacks()) {
      for (const reading of pack.readings) {
        if (reading.text === undefined) continue;
        expect(reading.source, `${pack.slug}: ${reading.title}`).toMatch(provenance);
      }
    }
  });

  it('still accepts a pack that has neither, so an older pack keeps working', () => {
    const bare = { ...getPack('secular') } as Record<string, unknown>;
    delete bare['orderOfService'];
    delete bare['readings'];
    const parsed = parsePack('secular.json', JSON.stringify(bare));
    expect(parsed.orderOfService).toEqual([]);
    expect(parsed.readings).toEqual([]);
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
    expect(() => getPack('klingon')).toThrow(/Available: buddhist, catholic, hindu/);
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
