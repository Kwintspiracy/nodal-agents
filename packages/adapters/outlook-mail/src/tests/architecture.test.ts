// @nodal-agents/adapter-outlook-mail — architecture invariant tests.
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

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scanForAgentSlugs,
  scanForHardcodedUuids,
  scanForForbiddenPackageImports,
  scanForPattern,
  assertNoViolations,
  readSource,
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

  it('uses the official @microsoft/microsoft-graph-client SDK — no hand-rolled fetch wrapping', () => {
    // Positive assertion. A violation scanner reports what must NOT be present;
    // this one is about what MUST be — invariant #7, official SDKs only.
    const source = readSource({ srcDir });
    expect(source).toContain("from '@microsoft/microsoft-graph-client'");
    expect(source).not.toContain('https://graph.microsoft.com/v1.0/me/messages');
  });

  it('no hardcoded email addresses in source files', () => {
    assertNoViolations(
      'adresse e-mail en dur',
      scanForPattern(
        { srcDir },
        {
          pattern: /['"`][a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}['"`]/,
          rule: 'hardcoded-email',
          allowMatch: (m) => m.includes('example.com') || m.includes('test.com'),
        },
      ),
    );
  });

  it('no AUTH_FAILED or hardcoded user-facing error strings', () => {
    assertNoViolations(
      'texte utilisateur en dur',
      scanForPattern(
        { srcDir },
        {
          pattern:
            /\[AUTH_FAILED\]|Re-authenticate in the dashboard|Outlook connector is not authenticated/,
          rule: 'user-facing-string',
        },
      ),
    );
  });
});
