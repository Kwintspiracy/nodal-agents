// @nodal-agents/web — architecture invariant tests.
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
  scanForProjectKeyCopies,
  scanForDirectTerminalCompleted,
  assertNoViolations,
} from '@nodal-agents/test-kit';
import { scanForServerUsesOfClientValues } from './scan-server-uses-client-value.ts';

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

  it('does not re-implement projectKey — the path identity rule lives in @nodal-agents/shared', () => {
    assertNoViolations('copie de projectKey', scanForProjectKeyCopies({ srcDir }));
  });

  it('no server component USES what a client module exports — it may only render it (#237)', () => {
    // La frontière serveur / client n'a ni type ni test unitaire pour la dire :
    // `dockedFormId` appelé depuis `/settings` a fait répondre 500 à la page
    // sur une stack fraîche, et seule la CI l'a vu. Voir le scanner.
    assertNoViolations(
      "valeur d'un module 'use client' servie côté serveur",
      scanForServerUsesOfClientValues({ srcDir }),
    );
  });

  it('never writes status=completed on agent_jobs — the runner primitive is the only terminal door (V&C T13)', () => {
    assertNoViolations('écriture terminale directe', scanForDirectTerminalCompleted({ srcDir }));
  });

  // Invariant #2 is deliberately NOT asserted here. It governs the RUNNER —
  // "the LLM speaks or the runner stays silent". This package ships prose to
  // humans by design, so the same scan would flag its whole reason to exist.
});
