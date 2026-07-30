// next-chunk-integrity.mjs — does a staged Next build actually ship every
// server chunk its own entries `require()` at runtime?
//
// Why this exists (0.8.0, published broken to npm):
// `output: 'standalone'` writes a COPY of the build to .next/standalone/. That
// copy silently dropped 7 of 40 files from .next/server/chunks/ — including
// chunks/5773.js, required by the dashboard home, agents, jobs and memories.
// Nothing flagged it: the chunks are absent from every .nft.json trace and from
// required-server-files.json, so no manifest in the build even mentions them.
// The proof it was not our config: (dashboard)/page.js loads its chunks in ONE
// call — b.X(0,[4674,3159,8437,960,7388,6402,7406,5773,8909,4574,3532,2575],…)
// — and the standalone copy kept 9 of those 12 and dropped 3. Same list, same
// instruction, different fate. Upstream bug in next@16.2.6.
//
// The build stayed green, `npm publish` stayed green, and users got HTTP 500 on
// every dashboard page while /api/health kept answering 200. So we stopped
// trusting the copy and check the ONE invariant that matters: every chunk id an
// entry asks for must exist on disk next to it.

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Entry files emitted by Next's App Router. Each ends with a webpack runtime
// call listing the chunk ids it needs before its module can run.
const ENTRY_NAMES = new Set(['page.js', 'route.js', 'middleware.js']);

/**
 * Chunk ids an entry file requires, read from its webpack runtime call:
 *   var b=require("../../webpack-runtime.js");b.C(a);
 *   var c=b.X(0,[4674,3159,5773],()=>b(b.s=49130));
 * `.X(<n>,[<ids>],…)` is webpack's "load these chunks, then run" form. Ids are
 * plain integers; an entry with no extra chunks emits an empty array.
 *
 * @param {string} source contents of a page.js / route.js / middleware.js
 * @returns {string[]} chunk ids, deduped, in first-seen order
 */
export function requiredChunkIds(source) {
  const ids = new Set();
  for (const match of source.matchAll(/\.X\(\s*\d+\s*,\s*\[([\d,\s]*)\]/g)) {
    for (const raw of match[1].split(',')) {
      const id = raw.trim();
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

function walkEntries(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkEntries(p));
    else if (ENTRY_NAMES.has(name)) out.push(p);
  }
  return out;
}

/**
 * Scan a staged `.next/server` directory for chunks that entries require but
 * that were never shipped.
 *
 * @param {string} serverDir path to a `.next/server` directory
 * @returns {{ entriesScanned: number, chunksPresent: number,
 *             missing: Array<{ id: string, requiredBy: string[] }> }}
 */
export function scanServerChunks(serverDir) {
  if (!existsSync(serverDir)) {
    throw new Error(`Not a Next server build directory: ${serverDir}`);
  }
  const chunksDir = join(serverDir, 'chunks');
  const present = new Set(
    existsSync(chunksDir) ? readdirSync(chunksDir).filter((f) => f.endsWith('.js')) : [],
  );

  const entries = [...walkEntries(join(serverDir, 'app'))];
  const middleware = join(serverDir, 'middleware.js');
  if (existsSync(middleware)) entries.push(middleware);

  /** @type {Map<string, string[]>} */
  const missing = new Map();
  for (const file of entries) {
    for (const id of requiredChunkIds(readFileSync(file, 'utf-8'))) {
      if (present.has(`${id}.js`)) continue;
      if (!missing.has(id)) missing.set(id, []);
      missing.get(id).push(file.slice(serverDir.length).replace(/\\/g, '/'));
    }
  }

  return {
    entriesScanned: entries.length,
    chunksPresent: present.size,
    missing: [...missing]
      .map(([id, requiredBy]) => ({ id, requiredBy }))
      .sort((a, b) => b.requiredBy.length - a.requiredBy.length),
  };
}

/**
 * Human-readable report. Returns null when the build is intact.
 *
 * @param {ReturnType<typeof scanServerChunks>} result
 * @returns {string | null}
 */
export function formatMissingChunks(result) {
  if (result.missing.length === 0) return null;
  const lines = [
    `${result.missing.length} server chunk(s) required by the build are MISSING ` +
      `(${result.chunksPresent} present, ${result.entriesScanned} entries scanned):`,
  ];
  for (const { id, requiredBy } of result.missing) {
    const shown = requiredBy.slice(0, 4).join(', ');
    const more = requiredBy.length > 4 ? ` … +${requiredBy.length - 4}` : '';
    lines.push(`  chunks/${id}.js — required by ${requiredBy.length}: ${shown}${more}`);
  }
  return lines.join('\n');
}
