import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

const packages = [
  'schemas',
  'db',
  'core',
  'ai',
  'media',
  'storage',
  'video',
  'tradition-packs',
] as const;

export default defineConfig({
  test: {
    globalSetup: ['./scripts/vitest-global-setup.ts'],
    projects: [
      ...packages.map((name) => ({
        test: {
          name,
          root: `./packages/${name}`,
          environment: 'node' as const,
          include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
        },
      })),
      {
        test: {
          name: 'worker',
          root: './apps/worker',
          environment: 'node' as const,
          include: ['src/**/*.test.ts'],
        },
      },
      {
        // Route handlers and server actions are ordinary functions; these run
        // them directly, with Next's cookie store and cache faked, so the whole
        // create → link → dashboard walkthrough is covered without a browser.
        resolve: {
          alias: { '@': path.resolve(here, 'apps/web/src') },
        },
        test: {
          name: 'web',
          root: './apps/web',
          environment: 'node' as const,
          include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
        },
      },
    ],
  },
});
