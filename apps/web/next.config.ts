import type { NextConfig } from 'next';

/**
 * Workspace packages are published as TypeScript source (no build step), so Next
 * has to compile them itself. Everything the app imports from `@col/*` goes in
 * `transpilePackages`.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: [
    '@col/core',
    '@col/db',
    '@col/media',
    '@col/schemas',
    '@col/storage',
    '@col/tradition-packs',
    '@col/video',
  ],
  /**
   * better-sqlite3 and sharp are native modules: they must stay `require()`d at
   * runtime rather than being bundled into the server output.
   */
  serverExternalPackages: ['better-sqlite3', 'sharp'],
  eslint: {
    // Linting is a repo-level concern (`pnpm lint`), not a build step.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
