// nodal-agents (CLI) — architecture invariant tests.
//
// This package had NO architecture test. That gap is how a personal agent slug
// reached shipped source: the guard existed in 15 packages and this was not one
// of them, so nothing looked at it. Wiring it up is the point of
// @nodal-agents/test-kit — one scanner, every package, no local copies to drift.

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scanForAgentSlugs,
  scanForHardcodedUuids,
  scanForDbDriverImports,
  scanForModuleReferences,
  assertNoViolations,
} from '@nodal-agents/test-kit';

const srcDir = join(fileURLToPath(import.meta.url), '..', '..');

/** Every `src/` of the workspace: apps/*, packages/*, packages/adapters/*. */
function workspaceSrcDirs(repoRoot: string): string[] {
  const out: string[] = [];
  for (const parent of ['apps', 'packages', join('packages', 'adapters')]) {
    for (const name of readdirSync(join(repoRoot, parent))) {
      const src = join(repoRoot, parent, name, 'src');
      if (existsSync(src)) out.push(src);
    }
  }
  return out;
}

describe('architecture invariants', () => {
  it('no agent or server slug hardcoded in source (invariant #1)', () => {
    assertNoViolations('slugs d\u2019agent', scanForAgentSlugs({ srcDir }));
  });

  it('no per-user UUID in source (invariant #6)', () => {
    assertNoViolations('UUID en dur', scanForHardcodedUuids({ srcDir }));
  });

  it('does not import a database driver (only packages/db may)', () => {
    assertNoViolations('driver DB', scanForDbDriverImports({ srcDir }));
  });

  // `embedded-postgres` answers `beforeExit` with `process.exit(0)` as soon as it
  // is loaded; lib/embedded-postgres-module.ts unhooks that and is the only door
  // (issue #698). Any other way to reach the package — `import`, `require`, a
  // `createRequire(...).resolve` followed by a computed `import()`, in product
  // or test code of ANY workspace package — would let a failing vitest run or a
  // CLI command exit 0 again. Only the name is needed to reach it, so the scan
  // looks for the name, file by file, comments aside.
  it('names embedded-postgres nowhere but lib/embedded-postgres-module.ts', () => {
    const repoRoot = join(srcDir, '..', '..', '..');
    const srcDirs = workspaceSrcDirs(repoRoot);
    // Proves the walk reaches the harness, the CLI and the other apps.
    expect(srcDirs).toEqual(
      expect.arrayContaining([srcDir, join(repoRoot, 'packages', 'test-kit', 'src')]),
    );
    assertNoViolations(
      'embedded-postgres hors de sa porte',
      scanForModuleReferences({
        srcDirs,
        moduleName: 'embedded-postgres',
        allowFiles: [
          'apps/cli/src/lib/embedded-postgres-module.ts',
          // This test, which has to name what it looks for.
          'apps/cli/src/tests/architecture.test.ts',
          // The deliberate bypass the exit-code guard needs: it loads the
          // package BEFORE the door, to prove the door still unhooks it.
          'packages/test-kit/src/tests/fixtures/pg-run-exit-code/global-setup-bypass.ts',
        ],
      }),
    );
  });

  // Invariant #2 is deliberately NOT asserted here. It governs the RUNNER —
  // "the LLM speaks or the runner stays silent". This package ships prose to
  // humans by design, so the same scan would flag its whole reason to exist.
});
