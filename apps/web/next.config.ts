import type { NextConfig } from 'next';
import type { Configuration } from 'webpack';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';

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
  output: 'standalone',
  // Next.js loads this config from apps/web/. The monorepo root is two
  // levels up. Without this, file-tracing roots at the filesystem drive
  // and the standalone output mirrors the absolute disk layout — breaks
  // when the install lives somewhere other than the dev machine.
  outputFileTracingRoot: resolve(process.cwd(), '..', '..'),
  // Packages with native bindings or runtime-resolved deps must NOT be
  // bundled by Next's webpack pass. Webpack inlines them as
  // `require("<absolute-build-path>")` which fails on any other machine.
  // Keeping them external means the runtime uses standard node_modules
  // lookup, which works wherever the package was npm-installed.
  serverExternalPackages: [
    'pdf-parse',
    'pdfjs-dist',
    '@napi-rs/canvas',
    'mammoth',
    'exceljs',
    'embedded-postgres',
    'googleapis',
    '@notionhq/client',
    '@mendable/firecrawl-js',
    '@tavily/core',
    'apify-client',
    // discord.js (Discord ChannelAdapter, D3) — its gateway layer
    // (@discordjs/ws) has a lazy `import('zlib-sync')` for optional
    // WebSocket compression that it itself catches when missing (zlib-sync
    // is a native addon, not a declared dependency). Webpack's static
    // analysis doesn't know that and fails the whole build trying to
    // resolve it. External, discord.js runs through plain Node `require` at
    // runtime, where the same dynamic import's `.catch()` handles it fine.
    'discord.js',
    // Baileys (WhatsApp transport core, Phase W) — same class of bug as
    // discord.js above: its optional peer deps (jimp, audio-decode →
    // @eshaz/web-worker) contain a FULLY dynamic `import(mod)` Turbopack can
    // never resolve statically, breaking every dashboard route's compile.
    '@whiskeysockets/baileys',
  ],
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
  // Headers de sécurité HTTP posés sur toutes les routes. Pas de CSP complète :
  // le bootstrap de thème inline (apps/web/src/app/layout.tsx, THEME_BOOTSTRAP)
  // tourne sans nonce, donc un script-src restrictif le casserait — ou forcerait
  // 'unsafe-inline' sur les scripts, ce qui annule l'essentiel de la protection
  // XSS d'une CSP. On se limite à frame-ancestors (redondant avec X-Frame-Options
  // ci-dessous, appartient à CSP niveau 2 et n'est pas ignoré par les navigateurs
  // qui le supportent). Durcissement de suivi : nonce sur le script inline +
  // CSP complète (script-src 'self' 'nonce-...', style-src, etc.).
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
        ],
      },
    ];
  },
  webpack(config: Configuration, { isServer }: { isServer: boolean }) {
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

    // Native + runtime-resolved deps that Webpack mustn't try to bundle.
    // `serverExternalPackages` covers TOP-LEVEL imports but transitive deps
    // (e.g. `pdfjs-dist` reached via `pdf-parse`) still get inlined as
    // `require("<absolute-build-path>")`, which crashes any consumer
    // machine. Forcing them external at the Webpack level keeps the
    // bundled chunk emitting plain `require('pdfjs-dist')` strings that
    // Node resolves via the installed node_modules at runtime.
    if (isServer) {
      const runtimeExternals = [
        'pdf-parse',
        'pdfjs-dist',
        '@napi-rs/canvas',
        'mammoth',
        'exceljs',
        'embedded-postgres',
        'googleapis',
        '@notionhq/client',
        '@mendable/firecrawl-js',
        '@tavily/core',
        'apify-client',
        'discord.js',
        '@whiskeysockets/baileys',
      ];
      const existing = config.externals ?? [];
      config.externals = Array.isArray(existing) ? existing : [existing];
      config.externals.push(({ request }, callback) => {
        if (
          request &&
          runtimeExternals.some((pkg) => request === pkg || request.startsWith(pkg + '/'))
        ) {
          // CommonJS require — Node resolves these at runtime via node_modules.
          return callback(null, `commonjs ${request}`);
        }
        callback();
      });
    }

    return config;
  },
};

export default nextConfig;
