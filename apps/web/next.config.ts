import type { NextConfig } from 'next';
import type { Configuration } from 'webpack';

const nextConfig: NextConfig = {
  transpilePackages: [
    '@nodalai/db',
    '@nodalai/auth',
    '@nodalai/delivery',
    '@nodalai/llm',
    '@nodalai/memory',
    '@nodalai/orchestration',
    '@nodalai/shared',
    '@nodalai/tools',
  ],
  // Empty turbopack config silences the "webpack config exists, no turbopack
  // config" warning. Workspace packages use extension-less relative imports
  // (e.g. `from './foo'`), which both Turbopack and webpack resolve natively
  // via tsconfig moduleResolution: Bundler. No resolver alias needed.
  turbopack: {},
  experimental: {
    // Restore a 30-second TTL so sidebar links don't spam the server on every request.
    staleTimes: {
      dynamic: 30,
      static: 180,
    },
    optimizePackageImports: ['@phosphor-icons/react'],
  },
  webpack(config: Configuration) {
    // Safety net: workspace package source no longer uses `.js` extensions in
    // relative imports (Turbopack-compatible), but if a future contributor
    // reintroduces a `.js` import, this alias keeps webpack resolving correctly.
    // Harmless no-op when no `.js` imports exist.
    if (!config.resolve) config.resolve = {};
    const prev = config.resolve.extensionAlias ?? {};
    config.resolve.extensionAlias = {
      ...prev,
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.jsx': ['.tsx', '.jsx'],
    };
    return config;
  },
};

export default nextConfig;
