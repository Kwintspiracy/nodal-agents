// version.ts — read installed CLI version + fetch latest from npm registry.
// Used by: update command (4.1) and version notice in up.ts (4.2).

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { execa } from 'execa';

// ─── Installed version ────────────────────────────────────────────────────────

/**
 * Locate the `package.json` that owns this CLI installation.
 *
 * Two layouts are supported (mirrors the BUNDLED_ROOT logic in processes.ts):
 *
 *  1. **Bundled pack** (`npm install -g`): `cli.js` and `package.json` are
 *     siblings in the same directory — the pack root produced by
 *     `scripts/build-pack.mjs`. Detected by looking for `runner.js` as a
 *     sibling (same signal used by processes.ts).
 *
 *  2. **Monorepo dev** (`tsx src/index.ts`): this file lives at
 *     `apps/cli/src/lib/version.ts`. Walk two directories up to reach
 *     `apps/cli/package.json`.
 */
function resolveCliPackageJsonPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));

  // Bundled mode: runner.js + package.json are siblings of cli.js (= here).
  if (existsSync(join(here, 'runner.js'))) {
    return join(here, 'package.json');
  }

  // Dev mode: src/lib → src → apps/cli
  return join(here, '..', '..', 'package.json');
}

/**
 * Return the version string declared in the CLI's own `package.json`.
 * Falls back to `"0.0.0"` if the file cannot be read (should never happen
 * in practice, but fail-safe prevents the version notice from crashing `up`).
 */
export function getInstalledVersion(): string {
  try {
    const pkgPath = resolveCliPackageJsonPath();
    // createRequire lets us JSON-import a file by absolute path in ESM context
    // without dynamic import() (which would be async).
    const _require = createRequire(import.meta.url);
    const pkg = _require(pkgPath) as { version?: string };
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// ─── Latest published version ─────────────────────────────────────────────────

/**
 * Fetch the latest published version of `nodal-agents` from the npm registry.
 *
 * Returns `null` on any failure (offline, npm not in PATH, registry timeout)
 * so callers never have to guard against thrown errors.  The timeout is kept
 * short (5 s) to avoid blocking `up`'s version notice.
 */
export async function getLatestVersion(): Promise<string | null> {
  try {
    const { stdout } = await execa('npm', ['view', 'nodal-agents', 'version'], {
      timeout: 5_000,
      reject: true,
    });
    const trimmed = stdout.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}
