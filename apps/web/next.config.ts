import type { NextConfig } from 'next';

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
    // Restore a 30-second TTL so sidebar links don't spam the server on every page.
    staleTimes: {
      dynamic: 30,
      static: 180,
    },
    optimizePackageImports: ['@phosphor-icons/react'],
  },
};

export default nextConfig;
