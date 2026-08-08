// @nodal-agents/adapter-firecrawl — architecture invariant tests.
//
// The three invariants EVERY adapter shares — no agent slug, no per-user UUID,
// no reach into db/llm/auth/memory — now come from @nodal-agents/test-kit.
//
// They used to be a local copy here and in eleven sibling packages, and all
// twelve copies checked FOUR slugs where the shared list checks twelve, so
// "cortex", "tatooine", "alfred", "sputnik", "displacer", "jennie", "stanley"
// and "sherlock" were unchecked in every adapter. Measured when folding them
// in: zero violations were hiding there, so this is prevention — unlike the
// runner, where the same divergence had hidden nine.
//
// Rules specific to this connector stay in this file, because they are about
// THIS third party, but they use the kit's walker rather than a local readdir.

import { describe, it } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scanForAgentSlugs,
  scanForHardcodedUuids,
  scanForForbiddenPackageImports,
  scanForPattern,
  assertNoViolations,
} from '@nodal-agents/test-kit';

const srcDir = join(fileURLToPath(import.meta.url), '..', '..');

/** An adapter talks to its third party, and to nothing else in the monorepo. */
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

  it('no AUTH_FAILED or hardcoded user-facing error strings', () => {
    assertNoViolations(
      'texte utilisateur en dur',
      scanForPattern(
        { srcDir },
        {
          pattern:
            /\[AUTH_FAILED\]|Re-authenticate in the dashboard|Firecrawl connector is not authenticated/,
          rule: 'user-facing-string',
        },
      ),
    );
  });
});
