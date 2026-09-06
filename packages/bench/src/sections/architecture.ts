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
  scanForMutatingSpawnOutsideIntent,
  scanForDirectTerminalCompleted,
  scanForCompleteJobCallers,
  scanForTerminalSendOutsideOutbox,
  scanFilesForDeliverableTypeLiterals,
} from '@nodal-agents/test-kit';
import type { Metric, Section } from '../types';
import { REPO_ROOT } from '../baseline';

/** Packages that ship prose to humans by design — invariant #2 governs the runner. */
const USER_FACING_OK = new Set(['apps/web', 'apps/cli', 'apps/docs', 'packages/catalog']);
/** The one package allowed to import a database driver. */
const DB_DRIVER_OK = new Set(['packages/db']);

/**
 * Les deux surfaces d'où part une écriture sur le disque, avec les fichiers
 * qui hébergent leur lanceur légitime.
 *
 * La règle est appliquée par package (pas sur tout le dépôt) parce que
 * l'empreinte et la liste d'exceptions sont propres à chacun. Ce que le banc
 * ajoute au test d'archi : la TENDANCE. Un `skipFiles` qui s'allonge est une
 * promesse qui s'effrite, et personne ne la voit dans une suite verte.
 *
 * Aucun `existsSync` de garde ici, contrairement à `packageDirs()` : ces deux
 * chemins sont nommés, pas découverts. S'ils disparaissent, le banc doit
 * tomber fort plutôt que compter zéro violation (invariant #4).
 */
const INTENT_LAUNCHERS: ReadonlyArray<{
  rel: string;
  pattern: RegExp;
  skipFiles: readonly string[];
}> = [
  {
    rel: 'packages/tools',
    pattern: /\bspawn\(/,
    skipFiles: ['builtin/code-task/process.ts', 'builtin/shell-engine.ts'],
  },
  {
    rel: 'apps/runner',
    pattern: /binding\.run\(/,
    skipFiles: ['cli-runtime/run-job.ts', 'cli-runtime/run-chat.ts'],
  },
];

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
  tests: [
    '@nodal-agents/test-kit:src/tests/architecture.test.ts',
    // Les deux points d'application de la règle « rien n'écrit hors du seam
    // d'intention » : la mécanique est prouvée sur fixtures ci-dessus, son
    // APPLICATION à l'arbre réel l'est ici.
    '@nodal-agents/tools:src/tests/architecture.test.ts',
    '@nodal-agents/runner:src/tests/architecture.test.ts',
  ],

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

    const launcherHits: string[] = [];
    for (const surface of INTENT_LAUNCHERS) {
      const violations = scanForMutatingSpawnOutsideIntent(
        { srcDir: join(REPO_ROOT, surface.rel, 'src'), skipFiles: surface.skipFiles },
        surface.pattern,
      );
      for (const v of violations) launcherHits.push(`${surface.rel}:${v.line}`);
    }

    // V&C T13 — une porte terminale, une sortie. Mêmes listes que le test
    // d'archi du runner (apps/runner/src/tests/architecture.test.ts) : le
    // banc ne relâche jamais une règle, il en suit la tendance.
    const runnerSrc = join(REPO_ROOT, 'apps/runner', 'src');
    const terminalWriteHits: string[] = [];
    for (const v of scanForDirectTerminalCompleted({
      srcDir: runnerSrc,
      skipFiles: ['job/finalize.ts', 'job/state.ts'],
    })) {
      terminalWriteHits.push(`apps/runner:${v.line}`);
    }
    for (const v of scanForDirectTerminalCompleted({
      srcDir: join(REPO_ROOT, 'apps/web', 'src'),
    })) {
      terminalWriteHits.push(`apps/web:${v.line}`);
    }
    for (const v of scanForCompleteJobCallers({
      srcDir: runnerSrc,
      skipFiles: ['job/finalize.ts', 'job/state.ts'],
    })) {
      terminalWriteHits.push(`apps/runner:${v.line} ${v.rule}`);
    }
    const terminalSendHits = scanForTerminalSendOutsideOutbox({
      srcDir: runnerSrc,
      skipFiles: [
        'delivery/outbox.ts',
        'approvals/notify.ts',
        'notify/code-transitions.ts',
        'cron/run-schedules.ts',
        'cron/reset-orphans.ts',
        'telegram/poller.ts',
      ],
    }).map((v) => `apps/runner:${v.line}`);
    const deliverableLiteralHits = scanFilesForDeliverableTypeLiterals([
      join(runnerSrc, 'job', 'finalize.ts'),
    ]).map((v) => `apps/runner/src/job/finalize.ts:${v.line}`);

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
      {
        id: 'mutating_launcher_violations',
        label: 'Écritures disque hors seam d’intention',
        value: launcherHits.length,
        unit: 'violations',
        direction: 'lower-is-better',
        detail: launcherHits.slice(0, 20),
      },
      {
        id: 'terminal_write_violations',
        label: 'Écritures terminales hors de la primitive (V&C)',
        value: terminalWriteHits.length,
        unit: 'violations',
        direction: 'lower-is-better',
        detail: terminalWriteHits.slice(0, 20),
      },
      {
        id: 'terminal_send_violations',
        label: 'Envois de canal hors de l’outbox (V&C)',
        value: terminalSendHits.length,
        unit: 'violations',
        direction: 'lower-is-better',
        detail: terminalSendHits.slice(0, 20),
      },
      {
        id: 'deliverable_literal_violations',
        label: 'Types de livrable en dur dans la primitive (V&C)',
        value: deliverableLiteralHits.length,
        unit: 'violations',
        direction: 'lower-is-better',
        detail: deliverableLiteralHits.slice(0, 20),
      },
    ];
  },
};
