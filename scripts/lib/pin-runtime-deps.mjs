// pin-runtime-deps.mjs — resolve every runtime dependency the pack declares to
// the EXACT version installed in this workspace.
//
// AUDIT 2026-08-07 (SUPPLY-001). The pack ships a PRE-BUILT web bundle compiled
// against whatever versions the workspace had at build time. Publishing caret
// ranges alongside it means `npm install -g nodal-agents` re-resolves them
// LATER, against a registry that has moved on — so the published tarball can
// break with no commit, no release, and no signal.
//
// That is not hypothetical: 0.8.1 shipped `next: "^16.2.6"`; the day next@16.3.0
// landed, every fresh install got a standalone server crashing on
// `TypeError: Cannot read properties of undefined (reading 'validationLevel')`
// and a dashboard that never came up. Same user-visible symptom as the 0.8.0
// chunk loss, different mechanism — the 0.8.1 chunk-integrity gate could not see
// it, because nothing was missing from the tarball.
//
// Build what you test, ship what you built.

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);

/**
 * Workspace manifests to attempt resolution from, in order.
 *
 * pnpm's non-hoisted layout puts a dependency under the workspace package that
 * declares it, not at the repo root — so a single root-relative lookup misses
 * most of them.
 */
export const DEFAULT_RESOLVE_BASES = [
  'apps/runner/package.json',
  'apps/web/package.json',
  'apps/cli/package.json',
  'packages/delivery/package.json',
  'packages/tools/package.json',
  'packages/llm/package.json',
  'packages/db/package.json',
  'packages/auth/package.json',
  'packages/adapters/notion/package.json',
  'packages/adapters/firecrawl/package.json',
  'packages/adapters/tavily/package.json',
  'packages/adapters/apify/package.json',
  'packages/adapters/gmail/package.json',
  'packages/adapters/mcp/package.json',
  'packages/adapters/google-drive/package.json',
  'package.json',
  // pnpm's hoisting directory. Last resort, and the only place some pack deps
  // can be found at all: `pg` and `@napi-rs/canvas` are declared by the pack
  // manifest but by no workspace package — `pg` arrives transitively through
  // drizzle/postgres, `@napi-rs/canvas` as an optional peer of pdfjs-dist.
  // Resolving from here still answers the real question ("which version is
  // installed right now"), which is what the pin has to reflect.
  'node_modules/.pnpm/node_modules/package.json',
];

/**
 * Installed version of `name`, or null when it cannot be resolved from any base.
 *
 * Two lookups per base, because a package may or may not expose `./package.json`
 * in its `exports` map: first the manifest directly, then the package entry
 * point followed by a walk up to the nearest package.json whose `name` matches
 * (the name check keeps a deeply-nested entry point from picking up a parent
 * package's manifest).
 */
export function installedVersion(name, repoRoot, bases = DEFAULT_RESOLVE_BASES) {
  for (const base of bases) {
    const from = dirname(resolve(repoRoot, base));

    let manifest;
    try {
      manifest = require.resolve(`${name}/package.json`, { paths: [from] });
    } catch {
      manifest = null;
    }
    if (manifest) {
      try {
        const version = JSON.parse(readFileSync(manifest, 'utf-8')).version;
        if (version) return version;
      } catch {
        /* malformed manifest — fall through to the entry-point walk */
      }
    }

    let entry;
    try {
      entry = require.resolve(name, { paths: [from] });
    } catch {
      continue;
    }
    let dir = dirname(entry);
    for (let up = 0; up < 12; up += 1) {
      const candidate = join(dir, 'package.json');
      if (existsSync(candidate)) {
        try {
          const pkg = JSON.parse(readFileSync(candidate, 'utf-8'));
          if (pkg.name === name && pkg.version) return pkg.version;
        } catch {
          /* malformed manifest — keep walking */
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

/**
 * Rewrite every value of `dependencies` to its exact installed version.
 *
 * Returns `{ pinned, unresolved }`. The caller decides what to do with
 * `unresolved` — build-pack.mjs fails the build (invariant #4: a silent
 * fallback to the declared range would reintroduce SUPPLY-001).
 *
 * Pure: never mutates the input.
 */
export function pinToInstalledVersions(dependencies, repoRoot, bases = DEFAULT_RESOLVE_BASES) {
  const pinned = {};
  const unresolved = [];
  for (const [name, declared] of Object.entries(dependencies)) {
    const version = installedVersion(name, repoRoot, bases);
    if (version) {
      pinned[name] = version;
    } else {
      unresolved.push(name);
      pinned[name] = declared;
    }
  }
  return { pinned, unresolved };
}

/** Human-readable failure text for a non-empty `unresolved` list. */
export function formatUnresolved(unresolved) {
  if (unresolved.length === 0) return '';
  return (
    `Cannot pin the pack's runtime dependencies — these are declared in ` +
    `build-pack.mjs but are not resolvable in this workspace:\n` +
    unresolved.map((n) => `   - ${n}`).join('\n') +
    `\n\nRun \`pnpm install\` first. Shipping a range instead would let the ` +
    `published tarball re-resolve later and break with no commit (SUPPLY-001).`
  );
}
