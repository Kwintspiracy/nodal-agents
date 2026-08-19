// @nodal-agents/adapter-cloudflare — architecture invariant tests.
// Shared invariants from @nodal-agents/test-kit (same as every adapter).

import { describe, it } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scanForAgentSlugs,
  scanForHardcodedUuids,
  scanForForbiddenPackageImports,
  assertNoViolations,
} from '@nodal-agents/test-kit';

const srcDir = join(fileURLToPath(import.meta.url), '..', '..');

/** An adapter talks to its third party (and the tools seam), never to db/llm/auth/memory. */
const FORBIDDEN_LAYERS = [
  '@nodal-agents/db',
  '@nodal-agents/llm',
  '@nodal-agents/auth',
  '@nodal-agents/memory',
];

describe('architecture invariants', () => {
  it('no agent slugs hardcoded in source files', () => {
    assertNoViolations('slugs d’agent', scanForAgentSlugs({ srcDir }));
  });

  it('no hardcoded UUIDs (per-user values) in source files', () => {
    assertNoViolations('UUID en dur', scanForHardcodedUuids({ srcDir }));
  });

  it('no direct imports from @nodal-agents/db, /llm, /auth, /memory', () => {
    assertNoViolations(
      'imports interdits',
      scanForForbiddenPackageImports({ srcDir }, FORBIDDEN_LAYERS),
    );
  });
});
