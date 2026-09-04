// architecture.test.ts — invariants du produit, appliqués mécaniquement.
//
// La mécanique vit dans @nodal-agents/test-kit : ces scanners étaient recopiés
// dans 15 fichiers, chacun avec sa liste de slugs et son marcheur. Quinze copies
// = quinze endroits à mettre à jour, et quinze chances qu'une devienne plus
// laxiste sans que personne ne relise celles qui passent. C'est arrivé : la
// version locale comparait sans normaliser la casse, donc « Cortex » passait là
// où « cortex » échouait.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scanForAgentSlugs,
  scanForUserFacingStrings,
  scanForProjectKeyCopies,
  formatViolations,
} from '@nodal-agents/test-kit';

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('invariant 1 — aucune métadonnée d’agent en dur', () => {
  it('src/ ne contient aucun slug d’agent connu', () => {
    const v = scanForAgentSlugs({ srcDir: SRC_DIR });
    if (v.length > 0) expect.fail(formatViolations('Invariant 1 violé', v));
  });
});

describe('invariant 2 — aucun texte utilisateur en dur', () => {
  it('src/ ne met aucune phrase dans la bouche de l’agent', () => {
    const v = scanForUserFacingStrings({ srcDir: SRC_DIR });
    if (v.length > 0) expect.fail(formatViolations('Invariant 2 violé', v));
  });
});

describe('architecture — la clé d’identité d’un chemin n’a qu’une source', () => {
  it('src/ ne recopie pas la règle « lettre de lecteur » de @nodal-agents/shared', () => {
    const v = scanForProjectKeyCopies({ srcDir: SRC_DIR });
    if (v.length > 0) expect.fail(formatViolations('Copie de projectKey hors packages/shared', v));
  });
});

describe('architecture — le moteur shell est PUR', () => {
  it('shell-engine.ts n’importe ni le contexte d’outil, ni la base, ni le workspace', () => {
    // Le plan « Vérifier & Corriger » lance les commandes de preuve par ce
    // moteur : il doit rester appelable sans job, sans agent, sans DB.
    const src = readFileSync(resolve(SRC_DIR, 'builtin', 'shell-engine.ts'), 'utf-8');
    for (const forbidden of ["from '../types'", '@nodal-agents/db', 'file-ops/workspace']) {
      expect(src.includes(forbidden), `shell-engine.ts importe ${forbidden}`).toBe(false);
    }
  });
});
