/**
 * Finding a browser to render with.
 *
 * Remotion renders by driving a headless Chromium, and normally downloads its
 * own on first use. That download is a network call to a host a locked-down CI
 * network may not allow, and "the render worked on my laptop" is not a standard
 * this product can meet — the failure mode is a family with no video.
 *
 * So: an explicitly configured browser wins, then any Chromium already sitting
 * on the machine (CI images almost always have one for Playwright or Puppeteer),
 * and only then Remotion's own. Callers that get `undefined` should say so
 * loudly rather than quietly skipping a render.
 */
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** Point this at a Chromium/Chrome binary to settle the question outright. */
export const BROWSER_ENV_VAR = 'REMOTION_BROWSER_EXECUTABLE';

/** Directories that hold one versioned browser per subdirectory. */
const BROWSER_POOLS = [
  '/opt/pw-browsers',
  path.join(process.env['HOME'] ?? '/root', '.cache/ms-playwright'),
  path.join(process.env['HOME'] ?? '/root', '.cache/puppeteer'),
];

/**
 * Where a binary sits inside one of those versioned directories, most wanted
 * first. A headless shell outranks a full Chrome everywhere, because current
 * Chrome builds have dropped the old headless mode that Remotion drives.
 */
const POOL_SUFFIXES = [
  'chrome-linux/headless_shell',
  'chrome-headless-shell-linux64/chrome-headless-shell',
  'chrome-linux/chrome',
  'chrome-linux64/chrome',
];

const PLAIN_PATHS = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
];

export type FoundBrowser = {
  executable: string;
  /** Where it came from, for a log line that explains itself. */
  source: 'env' | 'pool' | 'system';
};

export function findBrowser(env: NodeJS.ProcessEnv = process.env): FoundBrowser | undefined {
  const configured = env[BROWSER_ENV_VAR]?.trim();
  if (configured && existsSync(configured)) return { executable: configured, source: 'env' };

  for (const pool of BROWSER_POOLS) {
    if (!existsSync(pool)) continue;
    let entries: string[];
    try {
      entries = readdirSync(pool).sort();
    } catch {
      continue;
    }
    // Suffix outside, entry inside: a headless shell in any version beats a
    // full Chrome in the version that happens to sort first.
    for (const suffix of POOL_SUFFIXES) {
      for (const entry of entries) {
        const candidate = path.join(pool, entry, suffix);
        if (existsSync(candidate)) return { executable: candidate, source: 'pool' };
      }
    }
  }

  for (const candidate of PLAIN_PATHS) {
    if (existsSync(candidate)) return { executable: candidate, source: 'system' };
  }

  return undefined;
}

/** Just the path, for handing straight to `renderMedia({ browserExecutable })`. */
export function findBrowserExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return findBrowser(env)?.executable;
}

/**
 * What to print when there is no browser: the two things that fix it, not a
 * stack trace.
 */
export const NO_BROWSER_MESSAGE = [
  'No Chromium could be found for Remotion to render with.',
  `Set ${BROWSER_ENV_VAR} to a Chrome/Chromium binary, or let Remotion download`,
  'its headless shell (`npx remotion browser ensure`) on a network that allows',
  'remotion.media.',
].join(' ');
