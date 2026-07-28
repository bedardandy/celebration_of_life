import { defineConfig } from 'vitest/config';

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
    ],
  },
});
