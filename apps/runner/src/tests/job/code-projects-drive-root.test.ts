// code-projects-drive-root.test.ts — le jumeau runner du test de l'onglet Code.
//
// Les projets de code sont dérivés DEUX FOIS : une fois pour l'onglet Code
// (apps/web/src/lib/code-projects.ts), une fois pour le bloc Runtime injecté
// dans le prompt système (apps/runner/src/job/code-projects.ts). Elles ont
// divergé : la garde « une racine de disque n'est jamais un projet » n'existait
// que côté web. Résultat concret, avec un workspace posé sur `C:\` : l'onglet
// n'affichait rien, et le prompt annonçait à tous les agents un projet nommé
// `Users` — avec ses détenteurs.
//
// La même table de cas est rejouée des deux côtés. Tant que les deux
// dérivations vivent dans deux fichiers, elles sont épinglées par deux tests
// jumeaux : si l'une repart seule, l'un des deux tombe.

import { describe, it, expect } from 'vitest';
import { isDriveRoot } from '../../job/code-projects';

describe('isDriveRoot (runner) — jumeau du test de l’onglet Code', () => {
  it('reconnaît toutes les écritures d’une racine de disque', () => {
    for (const p of ['', '/', '//', 'C:', 'C:/', 'c:/', 'D:/']) {
      expect(isDriveRoot(p), `« ${p} » devrait être une racine de disque`).toBe(true);
    }
  });

  it('ne confond pas un vrai dossier avec une racine', () => {
    for (const p of ['/home/kwint', 'C:/Users', 'C:/Users/kwint/Dev/app']) {
      expect(isDriveRoot(p), `« ${p} » n’est PAS une racine de disque`).toBe(false);
    }
  });
});
