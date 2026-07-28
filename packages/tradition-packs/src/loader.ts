/**
 * Tradition packs: faith and culture as *data*.
 *
 * The whole point is that the codebase never contains `if (tradition ===
 * 'jewish')`. Every pack answers the same questions — when things happen, where
 * photo and story media belongs, what to do about music — so the product can
 * give a family a straight, respectful answer without anyone hard-coding a
 * religion into a component.
 *
 * Packs are validated the moment they load. A malformed pack is a bug we want
 * to hear about at boot, named, not three screens later in front of a family.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TraditionPackSchema, type TraditionPack } from '@col/schemas';

export const PACK_DATA_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
);

export class TraditionPackError extends Error {
  constructor(
    readonly packName: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`Tradition pack "${packName}": ${message}`);
    this.name = 'TraditionPackError';
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

export class UnknownTraditionError extends Error {
  constructor(
    readonly slug: string,
    readonly known: readonly string[],
  ) {
    super(`No tradition pack for "${slug}". Available: ${known.join(', ')}.`);
    this.name = 'UnknownTraditionError';
  }
}

/** Parse one pack's JSON text. `packName` is the file name, for the error. */
export function parsePack(packName: string, json: string): TraditionPack {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new TraditionPackError(packName, 'is not valid JSON', { cause: err });
  }

  const result = TraditionPackSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new TraditionPackError(packName, `failed validation\n${details}`, {
      cause: result.error,
    });
  }

  const expectedSlug = packName.replace(/\.json$/i, '');
  if (result.data.slug !== expectedSlug) {
    throw new TraditionPackError(
      packName,
      `declares slug "${result.data.slug}"; the file name must match the slug`,
    );
  }
  return result.data;
}

export function loadPacks(dir: string = PACK_DATA_DIR): Map<string, TraditionPack> {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const packs = new Map<string, TraditionPack>();
  for (const file of files) {
    const pack = parsePack(file, readFileSync(path.join(dir, file), 'utf8'));
    if (packs.has(pack.slug)) throw new TraditionPackError(file, `duplicate slug "${pack.slug}"`);
    packs.set(pack.slug, pack);
  }
  if (packs.size === 0) throw new Error(`No tradition packs found in ${dir}`);
  return packs;
}

// Eager: if a pack in this repo is broken, nothing that imports this module
// should start.
const PACKS = loadPacks();

export const TRADITION_SLUGS: readonly string[] = [...PACKS.keys()].sort();

/** Every pack, alphabetically by slug. */
export function listPacks(): TraditionPack[] {
  return TRADITION_SLUGS.map((slug) => PACKS.get(slug) as TraditionPack);
}

/** Throws `UnknownTraditionError`, which names the slugs that do exist. */
export function getPack(slug: string): TraditionPack {
  const pack = PACKS.get(slug);
  if (!pack) throw new UnknownTraditionError(slug, TRADITION_SLUGS);
  return pack;
}

export function findPack(slug: string): TraditionPack | undefined {
  return PACKS.get(slug);
}

export function hasPack(slug: string): boolean {
  return PACKS.has(slug);
}

/**
 * The pack to use when a family has not said (or has said "I'm not sure").
 * Secular is the least presumptuous default, and it is the easiest to change
 * later without losing work.
 */
export const DEFAULT_TRADITION_SLUG = 'secular';

export function getDefaultPack(): TraditionPack {
  return getPack(DEFAULT_TRADITION_SLUG);
}
