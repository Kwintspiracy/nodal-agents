// architecture.test.ts — invariants du produit, appliqués mécaniquement.
//
// Les scanners vivent dans @nodal-agents/test-kit : ils étaient auparavant
// recopiés dans 15 fichiers `architecture.test.ts`, chacun portant sa propre
// liste de slugs et son propre marcheur de répertoires. Quinze copies, c'est
// quinze endroits à mettre à jour au renommage d'un agent — et quinze chances
// qu'une devienne plus laxiste que les autres sans que personne ne relise celles
// qui passent.
//
// Ce fichier reste le point d'application POUR CE PACKAGE ; seule la mécanique
// est partagée.

import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scanForAgentSlugs,
  scanForUserFacingStrings,
  scanForDbDriverImports,
  scanForProjectKeyCopies,
  scanForMutatingSpawnOutsideIntent,
  scanForDirectTerminalCompleted,
  scanForCompleteJobCallers,
  scanForTerminalSendOutsideOutbox,
  scanFilesForDeliverableTypeLiterals,
  formatViolations,
} from '@nodal-agents/test-kit';
import { join } from 'node:path';

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('invariant 1 — aucune métadonnée d’agent en dur', () => {
  it('src/ ne contient aucun slug d’agent connu', () => {
    const violations = scanForAgentSlugs({ srcDir: SRC_DIR });
    if (violations.length > 0) {
      expect.fail(formatViolations('Invariant 1 violé', violations));
    }
  });
});

describe('invariant 2 — aucun texte utilisateur en dur dans le runner', () => {
  it('src/ ne met aucune phrase dans la bouche de l’agent', () => {
    const violations = scanForUserFacingStrings({ srcDir: SRC_DIR });
    if (violations.length > 0) {
      expect.fail(formatViolations('Invariant 2 violé', violations));
    }
  });
});

describe('architecture — le runner n’importe aucun driver de base', () => {
  it('src/ passe exclusivement par @nodal-agents/db', () => {
    const violations = scanForDbDriverImports({ srcDir: SRC_DIR });
    if (violations.length > 0) {
      expect.fail(formatViolations('Import de driver hors packages/db', violations));
    }
  });
});

describe('architecture — la clé d’identité d’un chemin n’a qu’une source', () => {
  it('src/ ne recopie pas la règle « lettre de lecteur » de @nodal-agents/shared', () => {
    const violations = scanForProjectKeyCopies({ srcDir: SRC_DIR });
    if (violations.length > 0) {
      expect.fail(formatViolations('Copie de projectKey hors packages/shared', violations));
    }
  });
});

/**
 * Les deux SEULS points d'où un runtime CLI part écrire dans un workspace.
 * Ils posent l'intention de mutation avant de lancer le binding ; un troisième
 * appel ailleurs écrirait hors vérification sans que rien ne rougisse.
 */
const CLI_RUNTIME_LAUNCHERS = ['cli-runtime/run-job.ts', 'cli-runtime/run-chat.ts'] as const;

// ─── Plan « Vérifier & Corriger », T13 : une porte terminale, une sortie ────

/**
 * Les deux SEULS fichiers qui écrivent le statut terminal de succès : la
 * primitive, et l'écriture interne qu'elle appelle. Tout autre `.update(
 * agentJobs)` posant `status: 'completed'` contournerait la décision de
 * vérification ET l'outbox sans qu'un test de comportement rougisse.
 */
const TERMINAL_WRITERS = ['job/finalize.ts', 'job/state.ts'] as const;

/**
 * Les envois de canal NON terminaux — une allowlist explicite, dont la
 * longueur est ce qu'on surveille : une demande d'approbation, une transition
 * de l'onglet Code, le rappel d'un cron, le reset des orphelins, le poller.
 * Le résultat terminal d'un job, lui, ne part que par l'outbox.
 */
const NON_TERMINAL_SENDERS = [
  'delivery/outbox.ts',
  'approvals/notify.ts',
  'notify/code-transitions.ts',
  'cron/run-schedules.ts',
  'cron/reset-orphans.ts',
  'telegram/poller.ts',
] as const;

describe('architecture — une seule porte terminale de succès (V&C T13)', () => {
  it('src/ ne pose status=completed sur agent_jobs que dans la primitive et son écriture interne', () => {
    const violations = scanForDirectTerminalCompleted({
      srcDir: SRC_DIR,
      skipFiles: TERMINAL_WRITERS,
    });
    if (violations.length > 0) {
      expect.fail(formatViolations('Écriture terminale directe hors de la primitive', violations));
    }
  });

  it('completeJob n’a aucun appelant hors de la primitive (c’est son écriture interne)', () => {
    const violations = scanForCompleteJobCallers({ srcDir: SRC_DIR, skipFiles: TERMINAL_WRITERS });
    if (violations.length > 0) {
      expect.fail(formatViolations('Appel de completeJob hors de la primitive', violations));
    }
  });

  it('src/ n’envoie un résultat terminal que par l’outbox — les autres envois sont sur allowlist', () => {
    const violations = scanForTerminalSendOutsideOutbox({
      srcDir: SRC_DIR,
      skipFiles: NON_TERMINAL_SENDERS,
    });
    if (violations.length > 0) {
      expect.fail(formatViolations('Envoi de canal hors de l’outbox', violations));
    }
  });

  it('la primitive ne mentionne aucun type de livrable — elle n’appelle que le registre', () => {
    const violations = scanFilesForDeliverableTypeLiterals([join(SRC_DIR, 'job', 'finalize.ts')]);
    if (violations.length > 0) {
      expect.fail(formatViolations('Type de livrable en dur dans la primitive', violations));
    }
  });
});

describe('architecture — le runtime CLI ne part écrire que du seam d’intention', () => {
  it('src/ ne lance un binding CLI que depuis run-job.ts et run-chat.ts', () => {
    const violations = scanForMutatingSpawnOutsideIntent(
      { srcDir: SRC_DIR, skipFiles: CLI_RUNTIME_LAUNCHERS },
      /binding\.run\(/,
    );
    if (violations.length > 0) {
      expect.fail(
        formatViolations(
          'Lancement de binding CLI hors des deux points qui posent l’intention',
          violations,
        ),
      );
    }
  });
});
