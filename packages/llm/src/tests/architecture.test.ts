// @nodal-agents/llm — architecture invariant tests.
//
// This package had NO architecture test. That gap is how a personal agent slug
// reached shipped source: the guard existed in 15 packages and this was not one
// of them, so nothing looked at it. Wiring it up is the point of
// @nodal-agents/test-kit — one scanner, every package, no local copies to drift.

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scanForAgentSlugs,
  scanForHardcodedUuids,
  scanForDbDriverImports,
  scanForUserFacingStrings,
  scanForModelClientsWithoutEndpoint,
  scanForModelProviderSdkImports,
  assertNoViolations,
} from '@nodal-agents/test-kit';

const srcDir = join(fileURLToPath(import.meta.url), '..', '..');
const repoRoot = join(srcDir, '..', '..', '..');

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

  it('every provider client is built with the resolved endpoint (stored or official address, stored key)', () => {
    assertNoViolations(
      'client de modèle sans resolveProviderEndpoint',
      scanForModelClientsWithoutEndpoint({ srcDir }),
    );
  });

  it('no other package of the monorepo builds a provider client itself', () => {
    const violations = ['apps', 'packages']
      .flatMap((top) => scanForModelProviderSdkImports({ srcDir: join(repoRoot, top) }))
      .filter((v) => !v.file.startsWith(srcDir));
    assertNoViolations('SDK de fournisseur importé hors de @nodal-agents/llm', violations);
    // The scan reads this package too: it would report its own imports if the
    // filter above were the only thing keeping them out, so it is not blind.
    expect(
      scanForModelProviderSdkImports({ srcDir: join(repoRoot, 'packages') }).some((v) =>
        v.file.startsWith(srcDir),
      ),
    ).toBe(true);
  });
});
