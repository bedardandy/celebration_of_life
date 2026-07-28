/**
 * Canned AI responses, read from `fixtures/ai/<task>/`.
 *
 * These files are what CI actually runs against. They are handwritten, invented,
 * and deliberately warm — a fixture that reads like lorem ipsum makes it very
 * easy to ship an interview that reads like lorem ipsum too.
 *
 * Lookup order for a request, most specific first:
 *   1. `<hash>.json` — hash of the matched text, for a truly pinned response
 *   2. any case whose `match` / `matchAny` appears in the matched text
 *   3. `default.json`
 *   4. nothing, and the mock synthesises a minimal object from the schema
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type FixtureCase = {
  id: string;
  task?: string;
  /** Substring (case-insensitive) that must appear in the request text. */
  match?: string;
  /** Any one of these matching is enough. */
  matchAny?: string[];
  /** A string is returned literally; an object is returned as pretty JSON. */
  response?: unknown;
  /**
   * A scripted sequence. Successive calls that resolve to this case walk the
   * list and then stay on the last entry — this is how "returns broken JSON
   * once, then valid JSON" is expressed without any randomness.
   */
  responses?: unknown[];
  /** Canned analysis per image basename, for vision requests. */
  images?: Record<string, unknown>;
  usage?: { inputTokens?: number; outputTokens?: number };
  note?: string;
  /** File name it was loaded from. Set by the loader, not by the author. */
  file?: string;
};

export class FixtureError extends Error {
  constructor(file: string, message: string, options?: { cause?: unknown }) {
    super(`AI fixture "${file}": ${message}`);
    this.name = 'FixtureError';
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/* -------------------------------------------------------------------------- */
/* where the fixtures live                                                     */
/* -------------------------------------------------------------------------- */

let cachedRoot: string | undefined;

/** Walk up to the workspace manifest; the web app and worker run from elsewhere. */
function workspaceRoot(): string {
  if (cachedRoot !== undefined) return cachedRoot;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 16; i += 1) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      cachedRoot = dir;
      return cachedRoot;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cachedRoot = process.cwd();
  return cachedRoot;
}

export function fixturesDir(env: Record<string, string | undefined> = process.env): string {
  const configured = env['AI_FIXTURES_DIR']?.trim();
  const target = configured && configured.length > 0 ? configured : './fixtures/ai';
  return path.isAbsolute(target) ? target : path.resolve(workspaceRoot(), target);
}

/* -------------------------------------------------------------------------- */
/* loading                                                                     */
/* -------------------------------------------------------------------------- */

const cache = new Map<string, FixtureCase[]>();

/** Test hook — call after writing fixtures on disk mid-run. */
export function clearFixtureCache(): void {
  cache.clear();
}

export function loadFixtureCases(task: string, dir = fixturesDir()): FixtureCase[] {
  const key = `${dir}::${task}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const taskDir = path.join(dir, task);
  const cases: FixtureCase[] = [];
  if (existsSync(taskDir)) {
    for (const file of readdirSync(taskDir)
      .filter((f) => f.endsWith('.json'))
      .sort()) {
      cases.push(parseFixtureFile(path.join(taskDir, file)));
    }
  }
  cache.set(key, cases);
  return cases;
}

export function parseFixtureFile(file: string): FixtureCase {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new FixtureError(path.basename(file), 'is not valid JSON', { cause: err });
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new FixtureError(path.basename(file), 'must be a JSON object');
  }
  const value = raw as FixtureCase;
  const id = typeof value.id === 'string' && value.id ? value.id : path.basename(file, '.json');
  if (value.response === undefined && value.responses === undefined && value.images === undefined) {
    throw new FixtureError(path.basename(file), 'needs one of "response", "responses" or "images"');
  }
  return { ...value, id, file: path.basename(file) } as FixtureCase;
}

/* -------------------------------------------------------------------------- */
/* matching                                                                    */
/* -------------------------------------------------------------------------- */

/** Stable key for a request. Whitespace-insensitive so prompt reflow is free. */
export function fixtureKey(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

export function findFixture(
  task: string,
  matchText: string,
  dir = fixturesDir(),
): FixtureCase | undefined {
  const cases = loadFixtureCases(task, dir);
  if (cases.length === 0) return undefined;

  const key = fixtureKey(matchText);
  const pinned = cases.find((c) => c.id === key);
  if (pinned) return pinned;

  const haystack = matchText.replace(/\s+/g, ' ').toLowerCase();
  for (const entry of cases) {
    const needles = [entry.match, ...(entry.matchAny ?? [])].filter(
      (n): n is string => typeof n === 'string' && n.length > 0,
    );
    if (needles.length === 0) continue;
    if (needles.some((needle) => haystack.includes(needle.replace(/\s+/g, ' ').toLowerCase()))) {
      return entry;
    }
  }

  return cases.find((c) => c.id === 'default');
}

/** Turn a fixture's `response` / `responses[n]` into the text a provider returns. */
export function fixtureResponseText(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}
