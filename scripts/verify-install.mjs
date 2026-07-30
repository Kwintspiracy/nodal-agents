#!/usr/bin/env node
// verify-install.mjs — health-check a nodal-agents install: does every runtime
// dependency it ships resolve, and do the runtime-critical ones actually LOAD?
//
// This is what would have caught the 0.6.5 node-fetch regression: loading
// @notionhq/client triggers its `require('node-fetch')`, so a bad transitive
// resolution shows up as BROKEN instead of a mystery crash at first boot.
//
// Usage:
//   node verify-install.mjs                 # checks the global `nodal-agents`
//   node verify-install.mjs <path-to-pkg>   # checks a specific install dir
//
// Exit code 0 = all good, 1 = something missing/broken.

import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, isAbsolute, resolve as pathResolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scanServerChunks, formatMissingChunks } from './lib/next-chunk-integrity.mjs';

// ── Locate the install ─────────────────────────────────────────────────────────
let pkgDir = process.argv[2];
if (pkgDir && !isAbsolute(pkgDir)) pkgDir = pathResolve(process.cwd(), pkgDir);
if (!pkgDir) {
  try {
    pkgDir = join(execSync('npm root -g', { encoding: 'utf8' }).trim(), 'nodal-agents');
  } catch {
    /* ignore */
  }
}
if (!pkgDir || !existsSync(join(pkgDir, 'package.json'))) {
  console.error('❌ nodal-agents install not found.');
  console.error('   Pass its path:  node verify-install.mjs <path-to-nodal-agents>');
  console.error('   (global dir is `npm root -g` + "\\nodal-agents")');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
const deps = Object.keys(pkg.dependencies || {});
const req = createRequire(join(pkgDir, 'package.json'));

console.log(`\n  Nodal-Agents ${pkg.version}`);
console.log(`  ${pkgDir}`);
console.log(`  ${deps.length} runtime dependencies\n`);

// Web-only deps are consumed by the Next standalone server, not import-safe in
// isolation — we still check they're PRESENT, but don't try to load them here.
const LOAD_SKIP = new Set(['next', 'react', 'react-dom', 'server-only']);

const results = [];
for (const dep of deps) {
  // 1) presence: does it resolve on disk?
  let resolvedPath;
  try {
    resolvedPath = req.resolve(dep + '/package.json');
  } catch {
    try {
      resolvedPath = req.resolve(dep);
    } catch (e) {
      results.push({ dep, status: 'MISSING', detail: e.message.split('\n')[0] });
      continue;
    }
  }
  // 2) load: for runtime-critical deps, actually import so broken native
  //    binaries / bad transitive resolution (node-fetch!) surface now.
  if (LOAD_SKIP.has(dep)) {
    results.push({ dep, status: 'PRESENT' });
    continue;
  }
  try {
    const entry = req.resolve(dep);
    await import(pathToFileURL(entry).href);
    results.push({ dep, status: 'OK' });
  } catch (e) {
    // A dep that is present but errors when loaded standalone (e.g. needs a
    // runtime context) is suspicious but not always fatal — flag it clearly.
    results.push({ dep, status: 'LOAD-ERROR', detail: e.message.split('\n')[0] });
  }
}

// ── Report ─────────────────────────────────────────────────────────────────────
const icon = (s) => (s === 'OK' || s === 'PRESENT' ? '✅' : s === 'MISSING' ? '❌' : '⚠️ ');
for (const r of results) {
  console.log(
    `  ${icon(r.status)} ${r.dep.padEnd(34)} ${r.status}${r.detail ? '  — ' + r.detail : ''}`,
  );
}

// ── Web build integrity ────────────────────────────────────────────────────────
// Dependencies resolving is not enough: 0.8.0 shipped with every npm dep intact
// but 7 server chunks missing from the Next build itself, so every dashboard
// page 500ed while /api/health stayed 200. Check what the build asks of itself.
let chunksBroken = false;
const serverDir = join(pkgDir, 'web', '.next', 'server');
if (existsSync(serverDir)) {
  const scan = scanServerChunks(serverDir);
  const report = formatMissingChunks(scan);
  if (report) {
    chunksBroken = true;
    console.log(`\n  ❌ Web build incomplete — the dashboard cannot render.`);
    console.log(
      report
        .split('\n')
        .map((l) => `  ${l}`)
        .join('\n'),
    );
  } else {
    console.log(
      `\n  ✅ Web build: ${scan.chunksPresent} server chunks, ` +
        `${scan.entriesScanned} entries, none missing`,
    );
  }
} else {
  console.log(`\n  ⚠️  No web build found at ${serverDir} — skipping chunk integrity check.`);
}

const missing = results.filter((r) => r.status === 'MISSING');
const broken = results.filter((r) => r.status === 'LOAD-ERROR');
console.log(`\n  ${results.length - missing.length - broken.length}/${results.length} healthy`);
if (missing.length)
  console.log(`  ❌ ${missing.length} MISSING: ${missing.map((r) => r.dep).join(', ')}`);
if (broken.length)
  console.log(`  ⚠️  ${broken.length} load-error: ${broken.map((r) => r.dep).join(', ')}`);
if (!missing.length && !broken.length) console.log(`  ✅ Every module is installed and loads.\n`);
if (chunksBroken) console.log(`  ❌ Web build is missing server chunks — dashboard will 500.\n`);

process.exit(missing.length || broken.length || chunksBroken ? 1 : 0);
