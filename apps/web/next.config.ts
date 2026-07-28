import type { NextConfig } from 'next';

/** Native addons: never bundle these, always `require()` them at runtime. */
const NATIVE_MODULES = ['better-sqlite3', 'sharp'];

type ExternalsCallback = (err?: Error, result?: string) => void;

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
  serverExternalPackages: NATIVE_MODULES,
  /**
   * `serverExternalPackages` alone does not catch these, because the import
   * comes from inside a `transpilePackages` workspace package (`@col/db`) and
   * so is compiled as first-party code. Bundling a .node addon silently breaks
   * its `bindings` lookup at runtime, which shows up as a MODULE_NOT_FOUND for
   * `.next/server/app/.../build/Release/better_sqlite3.node`. Keep both.
   */
  webpack: (config, { isServer }) => {
    if (isServer) {
      const externals = Array.isArray(config.externals) ? config.externals : [];
      config.externals = [
        ...externals,
        ({ request }: { request?: string }, callback: ExternalsCallback) =>
          request && NATIVE_MODULES.includes(request)
            ? callback(undefined, `commonjs ${request}`)
            : callback(),
      ];
    }
    return config;
  },
  eslint: {
    // Linting is a repo-level concern (`pnpm lint`), not a build step.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
