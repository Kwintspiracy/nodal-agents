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
  experimental: {
    // Restore a 30-second TTL so sidebar links don't spam the server on every request.
    staleTimes: {
      dynamic: 30,
      static: 180,
    },
    optimizePackageImports: ['@phosphor-icons/react'],
  },
  webpack(config: Configuration) {
    // Workspace packages use .js extensions in TypeScript ESM source (e.g. './ids.js').
    // Webpack cannot natively resolve .js → .ts without this resolver plugin.
    // This is safe: it only applies to transpiled workspace packages.
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
