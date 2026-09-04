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
  formatViolations,
} from '@nodal-agents/test-kit';

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
