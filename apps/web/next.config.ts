import type { NextConfig } from 'next';
import type { Configuration } from 'webpack';
import { networkInterfaces } from 'node:os';

// Next 15.3+ blocks dev requests whose Origin doesn't match the dev server's
// host. When BIND=0.0.0.0 the user reaches the dashboard via a LAN IP, so the
// HMR WebSocket and dev-time RSC requests get rejected unless the IP is in
// allowedDevOrigins. Without it, Next falls back to full page reloads — which
// wipes React state mid-sign-in. Compute the list at config evaluation time
// (the dev server reads it once on boot, so a DHCP IP change still requires a
// restart, same as bind itself).
function lanIPv4(): string[] {
  const ifs = networkInterfaces();
  const out: string[] = [];
  for (const list of Object.values(ifs)) {
    if (!list) continue;
    for (const iface of list) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}

const nextConfig: NextConfig = {
  allowedDevOrigins: ['localhost', '127.0.0.1', ...lanIPv4()],
  transpilePackages: [
    '@nodal-agents/db',
    '@nodal-agents/auth',
    '@nodal-agents/delivery',
    '@nodal-agents/llm',
    '@nodal-agents/memory',
    '@nodal-agents/orchestration',
    '@nodal-agents/shared',
    '@nodal-agents/tools',
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
