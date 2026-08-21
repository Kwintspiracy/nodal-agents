// architecture — invariants #1, #2 and the db-driver rule, across every package.
//
// The suite already asserts these per package. What the suite cannot tell you
// is the TREND: a package added without a guard drops silently out of coverage,
// and every remaining test still passes. So the bench counts both the
// violations AND the packages actually scanned.

import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  scanForAgentSlugs,
  scanForUserFacingStrings,
  scanForDbDriverImports,
  scanForHardcodedUuids,
} from '@nodal-agents/test-kit';
import type { Metric, Section } from '../types';
import { REPO_ROOT } from '../baseline';

/** Packages that ship prose to humans by design — invariant #2 governs the runner. */
const USER_FACING_OK = new Set(['apps/web', 'apps/cli', 'apps/docs', 'packages/catalog']);
/** The one package allowed to import a database driver. */
const DB_DRIVER_OK = new Set(['packages/db']);

function packageDirs(): string[] {
  const out: string[] = [];
  for (const base of ['packages', 'apps', join('packages', 'adapters')]) {
    const abs = join(REPO_ROOT, base);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) {
      if (name === 'adapters') continue; // walked separately
      const rel = `${base.replace(/\\/g, '/')}/${name}`;
      if (existsSync(join(REPO_ROOT, rel, 'src'))) out.push(rel);
    }
  }
  return out.sort();
}

export const architectureSection: Section = {
  id: 'architecture',
  label: 'Invariants d’architecture',
  why: 'Un slug d’agent ou un texte utilisateur codé en dur part chez toutes les installations.',
  tests: ['@nodal-agents/test-kit:src/tests/architecture.test.ts'],

  async run(): Promise<Metric[]> {
    const dirs = packageDirs();
    const slugHits: string[] = [];
    const proseHits: string[] = [];
    const driverHits: string[] = [];
    const uuidHits: string[] = [];

    for (const rel of dirs) {
      const srcDir = join(REPO_ROOT, rel, 'src');
      // The denylist module lists every forbidden slug as a literal, so
      // scanning it reports the RULE as eleven violations. A constant floor of
      // known-benign hits is worse than none: it hides the twelfth.
      const opts = { srcDir, skipFiles: ['packages/test-kit/src/architecture.ts'] };
      for (const v of scanForAgentSlugs(opts)) slugHits.push(`${rel}:${v.line} ${v.rule}`);
      for (const v of scanForHardcodedUuids(opts)) uuidHits.push(`${rel}:${v.line}`);
      if (!USER_FACING_OK.has(rel)) {
        for (const v of scanForUserFacingStrings(opts)) proseHits.push(`${rel}:${v.line}`);
      }
      if (!DB_DRIVER_OK.has(rel)) {
        for (const v of scanForDbDriverImports(opts)) driverHits.push(`${rel}:${v.line}`);
      }
    }

    return [
      {
        id: 'packages_scanned',
        label: 'Packages scannés',
        value: dirs.length,
        unit: 'packages',
        // A DROP means a package stopped being covered — the failure mode the
        // per-package suites cannot see. Higher is better, and a fall is a
        // regression even though nothing "failed".
        direction: 'higher-is-better',
      },
      {
        id: 'agent_slug_violations',
        label: 'Slugs d’agent en dur (invariant #1)',
        value: slugHits.length,
        unit: 'violations',
        direction: 'lower-is-better',
        detail: slugHits.slice(0, 20),
      },
      {
        id: 'user_facing_violations',
        label: 'Texte utilisateur en dur (invariant #2)',
        value: proseHits.length,
        unit: 'violations',
        direction: 'lower-is-better',
        detail: proseHits.slice(0, 20),
      },
      {
        id: 'db_driver_violations',
        label: 'Imports de driver DB hors packages/db',
        value: driverHits.length,
        unit: 'violations',
        direction: 'lower-is-better',
        detail: driverHits.slice(0, 20),
      },
      {
        id: 'hardcoded_uuid_violations',
        label: 'UUID par utilisateur en dur (invariant #6)',
        value: uuidHits.length,
        unit: 'violations',
        direction: 'lower-is-better',
        detail: uuidHits.slice(0, 20),
      },
    ];
  },
};
