// project-listing.test.ts — LA RÈGLE partagée, et le fait qu'elle soit
// PARTAGÉE (#364, revue Reviewer C passe 1).
//
// Le cas de `sidebar-projects-read.test.ts` prouve que les deux listes
// S'ACCORDENT sur une base donnée. C'est nécessaire et ce n'est pas assez :
// deux filtres écrits séparément, de même sémantique, s'accorderaient sur ce
// jeu-là et divergeraient au premier changement. Ce fichier prouve l'autre
// moitié — qu'il n'y a qu'UN endroit où la règle est écrite, et que les deux
// lecteurs y vont.
//
// Mutation vérifiée : une des deux lectures qui réécrit sa comparaison de
// `hidden` au lieu d'appeler `project-listing.ts` → « personne ne réécrit la
// règle » rougit.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isListedProject } from '../project-listing.ts';

const lib = join(dirname(fileURLToPath(import.meta.url)), '..');
const lire = (f: string): string => readFileSync(join(lib, f), 'utf8');

describe('la règle du projet listé @cap:travailler-sur-des-fichiers/moteur', () => {
  it('un projet RETIRÉ n’est pas listé ; un projet ordinaire l’est', () => {
    expect(isListedProject({ hidden: false })).toBe(true);
    expect(isListedProject({ hidden: true })).toBe(false);
  });

  it('les DEUX lecteurs vont la chercher au même endroit', () => {
    // La requête de la barre et la fusion de la page. Si l'un des deux cesse
    // d'importer ce module, c'est qu'il a recommencé à décider tout seul.
    expect(lire('project-actions.ts')).toContain("from './project-listing.ts'");
    expect(lire('workspaces.ts')).toContain("from './project-listing.ts'");
  });

  it('personne ne RÉÉCRIT la règle à côté', () => {
    // Le geste que la revue redoute : une comparaison de `hidden` recopiée
    // dans une des deux lectures, qui la ferait diverger en silence.
    for (const fichier of ['project-actions.ts', 'workspaces.ts']) {
      const source = lire(fichier);
      // Les lignes de CODE seulement : les commentaires de ces deux fichiers
      // parlent justement de `hidden`, et c'est très bien.
      const code = source
        .split('\n')
        .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
        .join('\n');
      expect(code, fichier).not.toMatch(/codeProjects\.hidden,\s*(true|false)/);
      expect(code, fichier).not.toMatch(/\.hidden\s*===\s*(true|false)/);
      expect(code, fichier).not.toMatch(/!\w+\.hidden\b/);
    }
  });
});
