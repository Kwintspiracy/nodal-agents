#!/usr/bin/env node
// build-pack.mjs — assemble the distributable npm package at `pack/`.
//
// Pipeline:
//   1. Build the runner (esbuild → apps/runner/dist/server.js)
//   2. Build the CLI (tsup → apps/cli/dist/index.js)
//   3. Build the web (next build → apps/web/.next/standalone/...)
//   4. Stage everything under `pack/` with a runtime-only package.json
//
// The resulting `pack/` can be:
//   - Run directly: `node pack/cli.js up` (after `cd pack && npm install`)
//   - Tarred:        `cd pack && npm pack` → nodal-agents-X.Y.Z.tgz

import { execSync } from 'node:child_process';
import {
  rmSync,
  mkdirSync,
  cpSync,
  writeFileSync,
  existsSync,
  statSync,
  readdirSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const packDir = resolve(repoRoot, 'pack');

const HEAP = '--max-old-space-size=4096';

function run(cmd) {
  console.log(`\n▶ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: repoRoot, env: { ...process.env, NODE_OPTIONS: HEAP } });
}

function sizeMB(p) {
  return (statSync(p).size / 1024 / 1024).toFixed(2) + ' MB';
}

// ─── 1. Clean target ────────────────────────────────────────────────────────
// On Windows, antivirus / indexer / cloud sync sometimes hold a handle on
// pack/ that makes a full rmdir fail with EBUSY. Walking the children and
// removing each works because the children's handles release faster than
// the parent dir's.
if (existsSync(packDir)) {
  for (const child of readdirSync(packDir)) {
    rmSync(resolve(packDir, child), { recursive: true, force: true });
  }
} else {
  mkdirSync(packDir, { recursive: true });
}

// ─── 2. Build everything ────────────────────────────────────────────────────
run('pnpm --filter @nodal-agents/runner build');
run('pnpm --filter nodal-agents build');
run('pnpm --filter @nodal-agents/web build');

// ─── 3. Stage CLI ───────────────────────────────────────────────────────────
cpSync(resolve(repoRoot, 'apps/cli/dist/index.js'), resolve(packDir, 'cli.js'));

// ─── 4. Stage runner ────────────────────────────────────────────────────────
cpSync(resolve(repoRoot, 'apps/runner/dist/server.js'), resolve(packDir, 'runner.js'));

// ─── 5. Stage web (Next.js standalone) ──────────────────────────────────────
// Next.js standalone with outputFileTracingRoot = repoRoot produces:
//   .next/standalone/apps/web/    → server.js + minimal node_modules
//   .next/standalone/node_modules → hoisted deps (also needed)
//   .next/static/                  → static assets (NOT auto-copied)
//   public/                        → NOT auto-copied (no public/ in our app)
//
// We flatten apps/web/ into pack/web/ to drop the monorepo-ish nesting.
const standaloneRoot = resolve(repoRoot, 'apps/web/.next/standalone');
const webOut = resolve(packDir, 'web');
mkdirSync(webOut, { recursive: true });

cpSync(resolve(standaloneRoot, 'apps/web/server.js'), resolve(webOut, 'server.js'));
cpSync(resolve(standaloneRoot, 'apps/web/.next'), resolve(webOut, '.next'), { recursive: true });
// Intentionally skip standalone's node_modules. pnpm produces a strict
// non-hoisted layout (top-level packages are symlinks into .pnpm/) that
// Next 16's runtime cannot resolve consistently — `@swc/helpers` and
// peer deps end up unreachable. Instead the pack's package.json declares
// `next`, `react`, `react-dom` as top-level dependencies. `npm install`
// then creates a flat node_modules that Next's server.js resolves via
// the standard Node lookup from web/server.js → pack/node_modules.
// Static assets: Next doesn't include these in standalone, must copy manually.
cpSync(resolve(repoRoot, 'apps/web/.next/static'), resolve(webOut, '.next/static'), {
  recursive: true,
});
// public/: copy if present (currently none in our app, future-proofs)
const publicSrc = resolve(repoRoot, 'apps/web/public');
if (existsSync(publicSrc)) {
  cpSync(publicSrc, resolve(webOut, 'public'), { recursive: true });
}

// ─── 6. Stage Drizzle migrations ────────────────────────────────────────────
// The runner calls `runMigrations(databaseUrl)` on boot via the CLI; that
// helper reads .sql files from packages/db/migrations/. Without these the
// migration step fails on first boot.
const migrationsSrc = resolve(repoRoot, 'packages/db/migrations');
if (existsSync(migrationsSrc)) {
  cpSync(migrationsSrc, resolve(packDir, 'migrations'), { recursive: true });
}

// ─── 7. Pack package.json ───────────────────────────────────────────────────
// Runtime deps only. Versions mirror what the workspace currently uses.
// When a workspace dep is added, mirror it here AND in apps/runner/build.mjs
// EXTERNALS array.
const packPkg = {
  name: 'nodal-agents',
  version: '0.2.1',
  description: 'Local-first AI agent platform with a web dashboard — install in one command.',
  license: 'MIT',
  repository: {
    type: 'git',
    url: 'git+https://github.com/Kwintspiracy/nodal-agents.git',
  },
  homepage: 'https://github.com/Kwintspiracy/nodal-agents',
  bin: {
    'nodal-agents': './cli.js',
  },
  type: 'module',
  engines: {
    node: '>=22',
  },
  files: ['cli.js', 'runner.js', 'web/**', 'migrations/**', 'README.md'],
  dependencies: {
    // ── CLI deps
    chalk: '^5.4.1',
    commander: '^14.0.3',
    'embedded-postgres': '^18.3.0-beta.17',
    execa: '^9.5.2',
    open: '^11.0.0',
    ora: '^9.4.0',
    prompts: '^2.4.2',
    // ── Runner deps (mirror apps/runner/build.mjs EXTERNALS)
    hono: '^4.12.18',
    '@hono/node-server': '^2.0.2',
    zod: '^4.4.3',
    'cron-parser': '^5.5.0',
    pg: '^8.13.1',
    postgres: '^3.4.5',
    'drizzle-orm': '^0.45.2',
    'better-auth': '^1.6.10',
    ai: '^6.0.177',
    '@ai-sdk/anthropic': '^3.0.76',
    '@ai-sdk/google': '^3.0.72',
    '@ai-sdk/groq': '^3.0.39',
    '@ai-sdk/mistral': '^3.0.36',
    '@ai-sdk/openai': '^3.0.63',
    '@ai-sdk/openai-compatible': '^2.0.47',
    '@ai-sdk/provider': '^3.0.10',
    'ollama-ai-provider-v2': '^3.5.0',
    googleapis: '^171.4.0',
    '@notionhq/client': '^2.3.0',
    '@mendable/firecrawl-js': '^4.22.0',
    '@tavily/core': '^0.7.0',
    'apify-client': '^2.23.0',
    'pdf-parse': '^2.4.5',
    mammoth: '^1.9.0',
    exceljs: '^4.4.0',
    // pdfjs-dist (transitive of pdf-parse) tries to require @napi-rs/canvas
    // optionally for canvas-based PDF rendering. Without it, SSR pages
    // that import the adapter tree crash with `ReferenceError: DOMMatrix
    // is not defined`. Declared at top level so npm install hoists it.
    '@napi-rs/canvas': '^0.1.80',
    // ── Web deps (Next.js standalone server requires these at runtime)
    next: '^16.2.6',
    react: '19.2.4',
    'react-dom': '19.2.4',
    'server-only': '^0.0.1',
    // Known leftover: Next 16.2.6 exact-pins `postcss: "8.4.31"`
    // (GHSA-qx2v-qp2m-jg93). `npm audit` flags 2 moderates because
    // npm can't override Next's exact pin from a downstream
    // dependency declaration. **Not a runtime risk** — we ship a
    // pre-built .next/ and postcss is build-only. Drops to clean
    // when Next 16.3 stable releases (currently canary).
  },
};

writeFileSync(resolve(packDir, 'package.json'), JSON.stringify(packPkg, null, 2) + '\n', 'utf-8');

// ─── 8. README ──────────────────────────────────────────────────────────────
if (existsSync(resolve(repoRoot, 'README.md'))) {
  cpSync(resolve(repoRoot, 'README.md'), resolve(packDir, 'README.md'));
}

// ─── 9. Report ──────────────────────────────────────────────────────────────
console.log('\n✔ Pack assembled at', packDir);
console.log('  cli.js   ', sizeMB(resolve(packDir, 'cli.js')));
console.log('  runner.js', sizeMB(resolve(packDir, 'runner.js')));
console.log('  web/server.js', sizeMB(resolve(packDir, 'web/server.js')));
console.log('\nNext steps:');
console.log('  cd pack && npm pack       # produce nodal-agents-0.1.0.tgz');
console.log('  cd pack && npm install -g . # local install test');
