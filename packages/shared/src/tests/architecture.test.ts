// @nodal-agents/shared — architecture invariant tests.
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
  scanForUserFacingStrings,
  assertNoViolations,
  scanForProjectKeyCopies,
  scanForMcpToolPrefixCopies,
  scanForNodalHomeCopies,
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

  it('no hardcoded user-facing prose (invariant #2)', () => {
    assertNoViolations('texte utilisateur en dur', scanForUserFacingStrings({ srcDir }));
  });

  it('hosts the ONE MCP tool prefix — no copy anywhere in apps/ or packages/ (#661)', () => {
    // Repo-wide on purpose: the copies lived in five packages, and a new
    // package would bring its own architecture test only if someone thought of it.
    const repo = join(srcDir, '..', '..', '..');
    for (const root of ['apps', 'packages']) {
      assertNoViolations(
        'copie du préfixe d’outil MCP',
        scanForMcpToolPrefixCopies({
          srcDir: join(repo, root),
          skipDirs: ['tests', '__tests__'],
          skipFiles: ['packages/shared/src/mcp-tool-prefix.ts'],
        }),
      );
    }
  });

  it('hosts the ONE Nodal home folder — no hand-built `.nodalai` path in apps/, packages/ or scripts/', () => {
    // Repo-wide, like the MCP prefix above: the copies lived in a dozen
    // packages and in the repo scripts, and each one ignored NODALAI_HOME.
    // JavaScript too: the scripts are .mjs (they reach the rule through
    // scripts/lib/nodal-home.mjs).
    const repo = join(srcDir, '..', '..', '..');
    const violations = ['apps', 'packages', 'scripts'].flatMap((root) =>
      scanForNodalHomeCopies({
        srcDir: join(repo, root),
        skipDirs: ['tests', '__tests__'],
        extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs'],
        // test-kit cannot depend on shared (shared's tests depend on it):
        // its test clusters avoid the DEFAULT install's ports, said there.
        skipFiles: ['packages/shared/src/nodal-home.ts', 'packages/test-kit/src/real-postgres.ts'],
      }),
    );
    assertNoViolations('chemin ~/.nodalai recopié', violations);
  });

  it('hosts the ONE path identity rule — no second copy even inside this package', () => {
    assertNoViolations(
      'copie de projectKey',
      scanForProjectKeyCopies({ srcDir, skipFiles: ['project-key.ts'] }),
    );
  });
});
