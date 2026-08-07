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
