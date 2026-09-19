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

/**
 * Origins this install accepts a server action from (NETWORK-001).
 *
 * Next matches `allowedOrigins` against the Origin header's host, port included,
 * so every name is emitted both bare and with the port the web is listening on.
 * next.config is re-evaluated when the standalone server boots (visible in
 * web.log: "Running next.config took Nms"), so `process.env.PORT` is the real
 * runtime port here, not a build-time guess.
 */
function allowedHosts(): string[] {
  const port = process.env['PORT'] ?? '3000';
  const names = ['localhost', '127.0.0.1', '[::1]', ...lanIPv4()];
  return names.flatMap((h) => [h, `${h}:${port}`]);
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
    // #219 — webpack-sources garde la source de chaque module DEUX fois, en
    // chaîne et en tampon, et n'interne aucune chaîne. Ce réglage coupe la
    // double copie et interne les chaînes pendant les trois compilations
    // (serveur, edge, client), qui se suivent dans le MÊME processus et
    // cumulent donc tout ce qu'elles retiennent.
    //
    // Mesuré le 20/09 sur l'arbre de la 0.8.11, plafond 12288, machine de
    // release : 15 223 Mo de pic sans ce réglage ni celui du cache ci-dessous,
    // 13 069 Mo avec les deux. La compilation passe de 13,6 à 14,0 min.
    webpackMemoryOptimizations: true,
    // NETWORK-001 (audit 2026-08-07). Next's server-action guard compares
    // `Origin` against `Host`, and only consults this allowlist when the two
    // DIFFER. Measured on a real packed install:
    //
    //   Origin: http://evil.test + Host: 127.0.0.1:3210 → 500 (allowlist wins)
    //   Origin: http://evil.test + Host: evil.test      → 200 (short-circuit)
    //
    // So this list is worth having — it pins the mismatched case to origins this
    // install actually knows, instead of trusting a Host that could be anything
    // — but it CANNOT close DNS rebinding on its own, because there Origin and
    // Host agree and the equality check short-circuits before the list is read.
    // What closes rebinding is the `Host` validation in src/proxy.ts.
    //
    // `allowedDevOrigins` above does not cover production at all. Same list,
    // computed the same way, so a phone on the LAN keeps working — a DHCP IP
    // change still needs a restart, exactly like `bind`.
    serverActions: {
      allowedOrigins: allowedHosts(),
    },
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
  webpack(config: Configuration, { dev, isServer }: { dev: boolean; isServer: boolean }) {
    // #219 — pas de cache webpack sur disque en production.
    //
    // Next pose `cache: { type: 'filesystem', maxMemoryGenerations: Infinity }`
    // pour les builds de production. `Infinity` veut dire que RIEN n'est évincé
    // de la couche mémoire du cache : les trois compilations se suivent dans le
    // même processus et le tas ne redescend jamais. À la fin, webpack sérialise
    // tout le paquet en mémoire avant de l'écrire — un second pic, par-dessus
    // le premier.
    //
    // Et ce cache ne sert à rien ici. `scripts/build-pack.mjs` PURGE
    // `apps/web/.next` avant chaque build de release — un build de release ne
    // doit pas dépendre de ce qu'il trouve — donc il est écrit à chaque fois et
    // relu jamais. La CI part d'un dépôt frais, même chose. Reste le développeur
    // qui enchaîne deux `pnpm build` : Turborepo répond déjà par son propre
    // cache quand rien n'a bougé, et quand quelque chose a bougé le cache
    // webpack se révoque de toute façon.
    //
    // `dev` reste intact : là, le cache sert à chaque frappe.
    if (!dev) config.cache = false;
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
