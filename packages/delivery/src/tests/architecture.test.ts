// @nodal-agents/delivery — architecture invariant tests.
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
  OUTBOUND_BRAND_CAST,
  scanForOutboundBypass,
  type OutboundExit,
} from '@nodal-agents/test-kit';

const srcDir = join(fileURLToPath(import.meta.url), '..', '..');

/** A value import (or re-export) of a module of `channels/`: a sender beside the seam. */
const CHANNEL_VALUE_IMPORT: OutboundExit = {
  rule: 'channel-module-beside-seam',
  pattern: /^\s*(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s+['"](?:\.\.?\/)+channels\//m,
};
const CHANNEL_DYNAMIC_IMPORT: OutboundExit = {
  rule: 'channel-module-beside-seam',
  pattern: /\bimport\(\s*['"](?:\.\.?\/)+channels\//,
};

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
});

describe('what a channel posts leaves through the outbound seam @cap:parler-par-canal-externe/moteur', () => {
  it('only the seam (outbound-channel.ts) reaches a channel module by value', () => {
    assertNoViolations(
      'module de canal atteint à côté de la couture de sortie',
      scanForOutboundBypass(
        { srcDir, skipDirs: ['tests', 'channels'], skipFiles: ['outbound-channel.ts'] },
        [CHANNEL_VALUE_IMPORT, CHANNEL_DYNAMIC_IMPORT, OUTBOUND_BRAND_CAST],
      ),
    );
  });
});
