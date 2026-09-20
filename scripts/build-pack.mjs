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
  readFileSync,
  existsSync,
  statSync,
  lstatSync,
  readdirSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { scanServerChunks, formatMissingChunks } from './lib/next-chunk-integrity.mjs';
import { pinToInstalledVersions, formatUnresolved } from './lib/pin-runtime-deps.mjs';
import { shouldPackMigrationFile } from './lib/migration-pack-filter.mjs';
import { mesurerCommande, verdictPic, plancherPour } from './lib/build-heap-sampler.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const packDir = resolve(repoRoot, 'pack');

// Le tas du build web.
//
// 4096 suffisait quand ce script a été écrit ; le 27/08 le build meurt en
// SIGABRT (status 134) à cette valeur, et passe à 12288. Le dashboard a grossi,
// c'est tout — mais la panne était trompeuse : `pnpm --filter … build` lancé à
// la main RÉUSSISSAIT, parce que la ligne ci-dessous ÉCRASE le NODE_OPTIONS de
// l'appelant. Même commande, deux issues, selon qu'on passe par le script.
//
// Un réglage explicite de l'appelant est donc respecté désormais : ce script
// pose un plancher, il ne rabote plus.
//
// Le 19/09, à la 0.8.11, le build meurt de nouveau à 12288 (SIGABRT, 134) et
// passe à 24576 en 20 min sur la machine du propriétaire (64 Go). Le dashboard
// a encore grossi (page de run, sidebar, dossiers), mais un doublement en trois
// jours se mesure avant de se justifier : une issue porte le pic réel et ce
// qui le fait monter. Le plancher suit la mesure, pas l'inverse.
//
// 20/09 (#219) — MESURÉ, et le besoin n'avait pas doublé : le plancher, si.
//
//   • Sur le runner de la CI, matériel identique d'une fois sur l'autre
//     (4 cœurs, 16 Go, Node 22), la compilation web passe de 69 s à la 0.8.10
//     à 76 s sur l'arbre de la 0.8.11. Le pack entier y tient sans NODE_OPTIONS.
//   • Sur la machine de release (24 cœurs, 64 Go, Node 26.4.0), même commit,
//     même plafond de 12288, `.next` purgé, une seule variable — les deux
//     réglages posés dans apps/web/next.config.ts :
//
//         sans : pic d'un processus 15 223 Mo, pic de l'arbre 15 487 Mo
//         avec : pic d'un processus 13 069 Mo, pic de l'arbre 13 603 Mo
//
//     Les deux builds passent toutes les phases qui demandent de la mémoire
//     sous 12288 : webpack, TypeScript, données de page, pages statiques.
//
// 12288 suffit donc. Le plancher est posé un cran au-dessus, 13 069 + 25 %
// arrondi au Go : ce que la mesure justifie, plus de quoi tenir sur une machine
// qui n'est pas celle-ci. Sans les deux réglages il faudrait 19 456 — c'est ce
// qu'ils achètent. Et ce chiffre ne se repose plus à l'aveugle : chaque pack
// mesure son pic et le compare à build-heap-reference.json.
const HEAP_FLOOR_MB = 16384;

function heapEnv() {
  const inherited = process.env['NODE_OPTIONS'] ?? '';
  const asked = /--max-old-space-size=(\d+)/.exec(inherited);
  if (asked && Number(asked[1]) >= HEAP_FLOOR_MB) return inherited;
  const withoutHeap = inherited.replace(/--max-old-space-size=\d+/g, '').trim();
  return `${withoutHeap} --max-old-space-size=${String(HEAP_FLOOR_MB)}`.trim();
}

function run(cmd) {
  console.log(`\n▶ ${cmd}`);
  execSync(cmd, {
    stdio: 'inherit',
    cwd: repoRoot,
    env: { ...process.env, NODE_OPTIONS: heapEnv() },
  });
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

// Purge apps/web/.next FIRST. A release build must not depend on what it finds.
//
// 2026-08-21: an independent validation run failed here with
//   Failed to copy traced files … .next\standalone\C:\Users\… ENOENT
// then a Windows crash (3221226505) — while the same command succeeded on a
// machine that happened to have purged the directory beforehand. The trace step
// of `next build` walks whatever `.next` already holds; a directory left behind
// by `next dev` (or by a previous crashed build) makes it chase paths that no
// longer exist. Same command, same commit, different outcome — which is exactly
// what a release script must never allow.
//
// Also keeps the dev cache from being shipped: it reached 89 GB on this machine.
const webNext = resolve(repoRoot, 'apps/web/.next');
if (existsSync(webNext)) {
  console.log('▶ Purging apps/web/.next so the build starts from a known state…');
  try {
    rmSync(webNext, { recursive: true, force: true });
  } catch (err) {
    // ENOTEMPTY here has one overwhelmingly likely cause, and the raw error
    // names none of it: a dev server is running and holding files open. Seen
    // 2026-08-21 while cutting the 0.8.5 pack — the stack trace pointed at
    // node:fs and said nothing about the cause or the cure.
    if (err.code === 'ENOTEMPTY' || err.code === 'EBUSY' || err.code === 'EPERM') {
      throw new Error(
        `Could not purge ${webNext} (${err.code}).\n\n` +
          '  Something is holding files in it — almost always a running dev server.\n' +
          '  Stop it first:  nodal-agents down\n\n' +
          '  This purge is not optional: `next build` traces whatever .next already\n' +
          '  holds, so a directory left by `next dev` produces a different pack from\n' +
          '  the same commit. A release build has to start from a known state.',
      );
    }
    throw err;
  }
}

run('pnpm --filter @nodal-agents/runner build');
run('pnpm --filter nodal-agents build');

// Le build web est MESURÉ, pas seulement lancé (#219).
//
// Le plancher ci-dessus est un chiffre que personne ne recalcule une fois posé :
// il ne redescend jamais, et le jour où le besoin monte pour de bon, le seul
// signal est un SIGABRT sans cause, trois jours plus tard, sur la machine de
// quelqu'un d'autre. Le build de release est le seul moment où ce build tourne
// de toute façon — donc le seul endroit où la mesure ne coûte rien.
const referenceHeap = JSON.parse(
  readFileSync(resolve(__dirname, 'build-heap-reference.json'), 'utf8'),
);
console.log('\n▶ pnpm --filter @nodal-agents/web build (mesuré)');
const mesureWeb = await mesurerCommande('pnpm --filter @nodal-agents/web build', {
  cwd: repoRoot,
  env: { ...process.env, NODE_OPTIONS: heapEnv() },
});
console.log(
  mesureWeb.relevesUtiles
    ? `\n  Mémoire du build web — pic d'un processus ${mesureWeb.picProcessusMo} Mo, ` +
        `pic de l'arbre ${mesureWeb.picArbreMo} Mo, sur ${mesureWeb.relevesUtiles} relevés, ` +
        `en ${mesureWeb.secondes} s.`
    : `\n  Mémoire du build web — NON MESURÉE : aucun relevé n'a vu de processus, ` +
        `en ${mesureWeb.secondes} s.`,
);
if (mesureWeb.codeSortie !== 0) {
  // Le message d'erreur dit lequel des trois cas on est dans, parce qu'ils se
  // ressemblent tous dans un terminal : un build tué par le tas rend un code
  // Windows opaque (134, ou 3221226505) juste après avoir frôlé son plafond,
  // et un build non mesuré rend un pic de zéro qui ressemble à un build sobre.
  throw new Error(
    `Le build web a échoué (code ${mesureWeb.codeSortie}).\n\n` +
      (!mesureWeb.relevesUtiles
        ? `  Le pic n'a pas été mesuré : aucun relevé n'a vu de processus.\n` +
          `  La cause de l'échec est à lire ci-dessus ; la mémoire ne peut ni être\n` +
          `  accusée ni être mise hors de cause à partir d'ici.\n`
        : `  Pic d'un processus : ${mesureWeb.picProcessusMo} Mo, plafond du tas ${HEAP_FLOOR_MB} Mo.\n` +
          (mesureWeb.picProcessusMo >= HEAP_FLOOR_MB
            ? `  Le pic a atteint le plafond : c'est une panne de mémoire.\n` +
              `  Mesurer un plancher plus haut — node scripts/measure-web-build-heap.mjs --cap ${plancherPour(mesureWeb.picProcessusMo)} —\n` +
              `  et porter le chiffre dans HEAP_FLOOR_MB avec la mesure (#219).\n`
            : "  Le pic est resté sous le plafond : la cause n'est pas la mémoire, lire l'erreur ci-dessus.\n")),
  );
}
const verdictWeb = verdictPic(mesureWeb, referenceHeap);
console.log(
  verdictWeb.niveau === 'ok' ? `  ${verdictWeb.message}` : `  ⚠ ${verdictWeb.message} (#219)`,
);

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
// The standalone copy of .next/server is INCOMPLETE — next@16.2.6 dropped 7 of
// 40 files from .next/server/chunks/ when producing it, and shipped 0.8.0 to
// npm with every dashboard page 500ing (MODULE_NOT_FOUND on chunks/5773.js).
// The real build is the source of truth: verified byte-identical on all 159
// shared files, with the standalone copy a strict subset. So we overlay the
// real .next/server on top — same bytes where they overlap, plus whatever the
// copy lost. Step 5b below then FAILS THE BUILD if anything is still missing.
cpSync(resolve(repoRoot, 'apps/web/.next/server'), resolve(webOut, '.next/server'), {
  recursive: true,
});
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

// ─── 5a. Drop the trace manifests ───────────────────────────────────────────
//
// `*.nft.json` sont les manifestes de TRAÇAGE de Next : la liste des fichiers
// qu'une page a touchés. Ils servent à FABRIQUER le standalone, jamais à le
// faire tourner — le serveur ne les ouvre pas.
//
// Le 27/08 ils pesaient **140 Mo chacun**, dix-neuf fois, soit 2,6 Go des
// 2,97 Go du pack. Le tarball atteignait 277 Mo et le registre npm l'a refusé
// en `413 Payload Too Large` — après le build, après le smoke-test, au moment
// le plus tardif possible.
//
// La cause de leur taille est locale à cette machine : `pnpm install` étant
// cassé (Node 26.4.0), les liens d'espace de travail sont posés à la main, et
// le traçage suit ces jonctions jusque dans des dossiers qui n'ont rien à voir
// avec le projet — extensions d'éditeur, applications Windows. D'où les
// avertissements « Failed to copy traced files » qui accompagnent chaque build
// ici. Les retirer supprime le symptôme ET le poids, sur toute machine.
let tracesDropped = 0;
let tracesBytes = 0;
(function dropTraces(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, entry.name);
    if (entry.isDirectory()) dropTraces(p);
    else if (entry.name.endsWith('.nft.json')) {
      tracesBytes += statSync(p).size;
      rmSync(p);
      tracesDropped++;
    }
  }
})(resolve(webOut, '.next'));
if (tracesDropped > 0) {
  console.log(
    `✔ Dropped ${String(tracesDropped)} trace manifests (${(tracesBytes / 1024 / 1024).toFixed(0)} MB) — build-time only`,
  );
}

// ─── 5b. Chunk integrity gate ───────────────────────────────────────────────
// Fail LOUD if any entry requires a server chunk the pack doesn't ship. This is
// the check that was missing when 0.8.0 shipped a build whose dashboard could
// never render: `next build` didn't complain, cpSync copied what it was given,
// verify-install only looked at npm dependencies, and CI never booted the pack.
// The only guard that caught it — assertWebRenders — runs on the USER's machine
// at first boot, i.e. after publish. This one runs here, before the tarball.
const chunkScan = scanServerChunks(resolve(webOut, '.next/server'));
const chunkReport = formatMissingChunks(chunkScan);
if (chunkReport) {
  console.error(`\n❌ Incomplete web build — refusing to assemble the pack.\n${chunkReport}`);
  process.exit(1);
}
console.log(
  `✔ Web chunk integrity: ${chunkScan.chunksPresent} chunks, ` +
    `${chunkScan.entriesScanned} entries, none missing`,
);

// ─── 6. Stage Drizzle migrations ────────────────────────────────────────────
// The runner calls `runMigrations(databaseUrl)` on boot via the CLI; that
// helper reads .sql files from packages/db/migrations/ plus meta/_journal.json.
// Without these the migration step fails on first boot.
//
// drizzle-kit's meta/NNNN_snapshot.json files are filtered OUT: 12 files,
// 1.3 MB, five times the weight of all 87 migrations combined (274 kB), and
// the migrator never opens them — it reads exactly one file out of meta/ (see
// lib/migration-pack-filter.mjs for the reference into drizzle-orm's source).
// They exist so `drizzle-kit generate` can diff schemas at development time.
const migrationsSrc = resolve(repoRoot, 'packages/db/migrations');
if (existsSync(migrationsSrc)) {
  cpSync(migrationsSrc, resolve(packDir, 'migrations'), {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(migrationsSrc.length).replace(/^[/\\]/, '');
      // The root call passes the folder itself (rel === ''); keep it, and keep
      // every directory so the walk can reach the files inside.
      if (rel === '') return true;
      return shouldPackMigrationFile(rel);
    },
  });
}

// ─── 6b. Stage the documentation index ──────────────────────────────────────
// `nodal_docs` (packages/tools/src/builtin/docs-index.ts) reads this file at
// runtime to answer "where in the dashboard do I do X". Same layout rule as the
// migrations above: it ships as a SIBLING of the bundle at the pack root, and
// the reader probes sibling-first, dev-layout-second. Missing, the tool throws
// with the paths it probed rather than answering "nothing found".
//
// FAIL THE BUILD when it is absent: a pack that boots without it turns every
// platform question back into the guess this feature exists to stop, and
// nothing else in the pipeline would notice.
const docsIndexSrc = resolve(repoRoot, 'packages/tools/docs-index.json');
if (!existsSync(docsIndexSrc)) {
  console.error('✖ packages/tools/docs-index.json is missing.');
  console.error('  It is generated by apps/docs/scripts/gen-docs-index.ts');
  console.error(
    '  (`pnpm build`, or `pnpm --filter @nodal-agents/docs gen`) and must be committed.',
  );
  process.exit(1);
}
cpSync(docsIndexSrc, resolve(packDir, 'docs-index.json'));
console.log('✔ Docs index staged: docs-index.json');

// ─── 7. Pack package.json ───────────────────────────────────────────────────
// Runtime deps only. The versions written below are RANGES for readability, but
// every one of them is rewritten to the EXACT installed version by
// `pinToInstalledVersions()` before the file is written (see §7a). When a
// workspace dep is added, mirror it here AND in apps/runner/build.mjs
// EXTERNALS array.
// Single source of truth for the published version: apps/cli/package.json.
// (Previously hardcoded here → drifted from the bumped version at publish time.)
const cliPkgVersion = JSON.parse(
  readFileSync(resolve(repoRoot, 'apps/cli/package.json'), 'utf-8'),
).version;
const packPkg = {
  name: 'nodal-agents',
  version: cliPkgVersion,
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
  files: ['cli.js', 'runner.js', 'web/**', 'migrations/**', 'docs-index.json', 'README.md'],
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
    '@ai-sdk/deepseek': '^2.0.38',
    '@ai-sdk/google': '^3.0.72',
    '@ai-sdk/groq': '^3.0.39',
    '@ai-sdk/mistral': '^3.0.36',
    '@ai-sdk/openai': '^3.0.63',
    '@ai-sdk/openai-compatible': '^2.0.47',
    '@ai-sdk/provider': '^3.0.10',
    '@openrouter/ai-sdk-provider': '^2.9.0',
    'ollama-ai-provider-v2': '^3.5.0',
    googleapis: '^171.4.0',
    '@notionhq/client': '^2.3.0',
    '@mendable/firecrawl-js': '^4.22.0',
    '@tavily/core': '^0.7.0',
    'apify-client': '^2.23.0',
    'pdf-parse': '^2.4.5',
    mammoth: '^1.12.0',
    exceljs: '^4.4.0',
    docx: '^9.7.1',
    pptxgenjs: '^4.0.1',
    officeparser: '^7.1.0',
    // ── Community-skill install (fetch + unpack SKILL.md archives)
    tar: '^7.5.16',
    fflate: '^0.8.3',
    // pdfjs-dist (transitive of pdf-parse) tries to require @napi-rs/canvas
    // optionally for canvas-based PDF rendering. Without it, SSR pages
    // that import the adapter tree crash with `ReferenceError: DOMMatrix
    // is not defined`. Declared at top level so npm install hoists it.
    '@napi-rs/canvas': '^0.1.80',
    // ── Channel SDKs (next.config.ts serverExternalPackages: the standalone
    // web build does NOT bundle these — dashboard routes `require()` them at
    // runtime via pack/node_modules, so they MUST be declared here. Missing
    // them = every (dashboard) route 500s with MODULE_NOT_FOUND while the
    // runner still boots fine (it bundles its own copies) — caught live on
    // the 0.7.8 pack ritual, invisible to verify-install until declared.)
    'discord.js': '^14.26.5',
    // EXACT pin, no caret: ^6.7.23 resolves to 6.17.16 (chronologically OLDER
    // despite the higher number), deprecated with a message-spoofing CVE.
    // Mirrors packages/delivery/package.json.
    '@whiskeysockets/baileys': '6.7.23',
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
  // Ship exceljs INSIDE the tarball instead of letting `npm install -g` fetch it.
  // exceljs is stale and drags in deprecated transitives (glob@7 "security",
  // inflight "memory leak", fstream, rimraf@2, uuid@8) whose deprecation warnings
  // scare users at install — even though they're upstream cruft, not reachable
  // vulns. npm `overrides` do NOT reach a global install (verified empirically),
  // so the only way to silence them is to stop re-resolving exceljs from the
  // registry. Bundling adds ZERO bytes to what a user downloads (exceljs was
  // always fetched) — it just rides in our tarball. Long-term fix: replace exceljs
  // (blocked today: SheetJS left npm, xlsx-kit still young). See docs/proposals.
  // ONLY exceljs — it's CommonJS + self-contained, and the source of the SCARY
  // warnings (glob "security", inflight "memory leak"). Do NOT bundle the
  // node-fetch chain: node-fetch@3 is ESM-only and, frozen into the tarball, it
  // displaced the node-fetch@2 that @notionhq/client requires via CommonJS —
  // "Cannot find module 'node-fetch'" crashed the runner at startup on fresh
  // installs. The one benign leftover (node-domexception) is not worth that risk.
  bundledDependencies: ['exceljs'],
};

// ─── 7a. Pin every runtime dep to its EXACT installed version ────────────────
// SUPPLY-001 (audit 2026-08-07). The list above is the source of truth for WHAT
// ships; this pass decides WHICH VERSION, from what is actually installed right
// now. Rationale and the 0.8.1 incident: scripts/lib/pin-runtime-deps.mjs.
//
// Fails loud (invariant #4) when a declared dep cannot be resolved: a silent
// fallback to the declared range would reintroduce exactly the defect this closes.
const { pinned, unresolved } = pinToInstalledVersions(packPkg.dependencies, repoRoot);
if (unresolved.length > 0) {
  console.error(`\n❌ ${formatUnresolved(unresolved)}\n`);
  process.exit(1);
}
packPkg.dependencies = pinned;

console.log(
  `✔ Pinned ${Object.keys(pinned).length} runtime deps to their exact installed ` +
    `versions (next@${pinned.next})`,
);

writeFileSync(resolve(packDir, 'package.json'), JSON.stringify(packPkg, null, 2) + '\n', 'utf-8');

// ─── 7b. Stage bundledDependencies into pack/node_modules ─────────────────────
// `npm pack`/`npm publish` embeds the bundledDependencies' directories from
// pack/node_modules. We install ONLY that subtree in isolation (fast — not the
// whole dep tree) and copy it in, so the published tarball ships exceljs and its
// stale transitives instead of the user's `npm install -g` re-resolving (and
// warning about) them.
const bundled = packPkg.bundledDependencies ?? [];
if (bundled.length > 0) {
  console.log(`\n▶ Staging bundledDependencies (${bundled.join(', ')})…`);
  const tmpDir = resolve(repoRoot, '.pack-bundle-tmp');
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  const tmpPkg = {
    name: '_bundle',
    version: '0.0.0',
    private: true,
    // Direct deps use the pinned range; bundled transitives (e.g. node-fetch /
    // fetch-blob / node-domexception, not in `dependencies`) fall back to latest.
    dependencies: Object.fromEntries(bundled.map((d) => [d, packPkg.dependencies[d] ?? 'latest'])),
  };
  writeFileSync(resolve(tmpDir, 'package.json'), JSON.stringify(tmpPkg, null, 2) + '\n', 'utf-8');
  execSync('npm install --no-audit --no-fund --no-package-lock', {
    cwd: tmpDir,
    stdio: 'inherit',
  });
  cpSync(resolve(tmpDir, 'node_modules'), resolve(packDir, 'node_modules'), { recursive: true });
  rmSync(tmpDir, { recursive: true, force: true });
  console.log('✔ bundledDependencies staged in pack/node_modules');
}

// ─── 8. README ──────────────────────────────────────────────────────────────
if (existsSync(resolve(repoRoot, 'README.md'))) {
  cpSync(resolve(repoRoot, 'README.md'), resolve(packDir, 'README.md'));
}

// ─── 8b. Size gate ──────────────────────────────────────────────────────────
//
// Le registre npm refuse un tarball trop gros par un `413 Payload Too Large`,
// et il le fait AU MOMENT DU PUBLISH — c'est-à-dire après le build, après le
// smoke-test, quand tout semblait prêt. C'est arrivé le 27/08 : 277 Mo de
// tarball, refusés, pour des manifestes de traçage qui n'avaient rien à faire
// là (voir l'étape 5a).
//
// Le seuil porte sur le contenu NON COMPRESSÉ, seule mesure disponible ici
// sans produire le tarball. Un pack sain pèse ~350 Mo décompressés ; 1 Go
// laisse de la marge tout en attrapant une dérive d'un ordre de grandeur.
const MAX_UNPACKED_MB = 1024;
function dirSizeMB(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.endsWith('.tgz')) continue; // un tarball d'un run précédent
    const p = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      total += dirSizeMB(p) * 1024 * 1024;
      continue;
    }
    // `lstatSync`, pas `statSync` : sous Linux `node_modules/.bin` est plein de
    // LIENS symboliques, et `statSync` suit le lien — un lien vers une cible
    // absente fait tomber tout le script en ENOENT. C'est ce qui a cassé la CI
    // le 27/08, une heure après l'ajout de cette garde : elle passait sous
    // Windows, où npm écrit des shims et non des liens.
    //
    // On mesure donc le lien lui-même (quelques octets), ce qui est aussi la
    // bonne mesure : le tarball ne duplique pas la cible.
    try {
      total += lstatSync(p).size;
    } catch {
      // Un fichier qui disparaît sous nos pieds ne doit pas faire échouer un
      // simple calcul de taille.
    }
  }
  return total / 1024 / 1024;
}
const unpackedMB = dirSizeMB(packDir);
if (unpackedMB > MAX_UNPACKED_MB) {
  throw new Error(
    `Pack too large: ${unpackedMB.toFixed(0)} MB unpacked (limit ${String(MAX_UNPACKED_MB)} MB).\n\n` +
      '  npm would refuse this with 413 Payload Too Large at publish time.\n' +
      '  Find what grew:  Get-ChildItem pack -Recurse -File | Sort-Object Length -Descending | Select -First 10\n',
  );
}

// ─── 9. Report ──────────────────────────────────────────────────────────────
console.log(
  `\n✔ Pack size: ${unpackedMB.toFixed(0)} MB unpacked (limit ${String(MAX_UNPACKED_MB)})`,
);
console.log('\n✔ Pack assembled at', packDir);
console.log('  cli.js   ', sizeMB(resolve(packDir, 'cli.js')));
console.log('  runner.js', sizeMB(resolve(packDir, 'runner.js')));
console.log('  web/server.js', sizeMB(resolve(packDir, 'web/server.js')));
console.log('\nNext steps:');
console.log(`  cd pack && npm pack       # produce nodal-agents-${cliPkgVersion}.tgz`);
console.log('  cd pack && npm install -g . # local install test');
