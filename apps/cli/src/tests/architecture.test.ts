// nodal-agents (CLI) — architecture invariant tests.
//
// This package had NO architecture test. That gap is how a personal agent slug
// reached shipped source: the guard existed in 15 packages and this was not one
// of them, so nothing looked at it. Wiring it up is the point of
// @nodal-agents/test-kit — one scanner, every package, no local copies to drift.

import { describe, it } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scanForAgentSlugs,
  scanForHardcodedUuids,
  scanForDbDriverImports,
  scanForPattern,
  assertNoViolations,
} from '@nodal-agents/test-kit';

const srcDir = join(fileURLToPath(import.meta.url), '..', '..');

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
  // is loaded; `importEmbeddedPostgres` removes that hook and is the only door
  // (issue #698). A direct import anywhere — product or test harness, tests
  // included — would let a failing vitest run or a CLI command exit 0 again.
  it('loads embedded-postgres only through importEmbeddedPostgres', () => {
    const pattern = /(?:import\(\s*|from\s+)['"]embedded-postgres['"]/;
    const skipDirs = ['node_modules', 'dist'];
    assertNoViolations('import direct d’embedded-postgres', [
      ...scanForPattern(
        { srcDir, skipDirs, skipFiles: ['lib/embedded-postgres-module.ts'] },
        { pattern, rule: 'embedded-postgres-direct-import' },
      ),
      ...scanForPattern(
        { srcDir: join(srcDir, '..', '..', '..', 'packages', 'test-kit', 'src'), skipDirs },
        { pattern, rule: 'embedded-postgres-direct-import' },
      ),
    ]);
  });

  // Invariant #2 is deliberately NOT asserted here. It governs the RUNNER —
  // "the LLM speaks or the runner stays silent". This package ships prose to
  // humans by design, so the same scan would flag its whole reason to exist.
});
