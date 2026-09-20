// migration-gap-refusal.test.ts — ce que le lanceur DIT quand il refuse de
// servir une base à laquelle il manque une migration (#298).
//
// @cap:installer-et-demarrer/moteur
//
// La détection est prouvée dans `packages/db` (`migration-gaps.test.ts`), la
// réparation contre un vrai Postgres aussi (`migration-gap-repair.pg.test.ts`).
// Reste la seule chose que la personne verra : le refus. Le 20/09/2026 le
// produit servait une base amputée SANS RIEN DIRE, et le coût n'était pas la
// panne — c'était de ne pas savoir pourquoi « Remove from list » échouait.
// Un refus qui ne nommerait pas la migration manquante, ou qui donnerait une
// commande approximative, rejouerait exactement ça.
//
// Mutation vérifiée : le `--dev` retiré de la commande rendue → le troisième
// cas rougit, et un copier-coller renverrait un poste de dev en production.
// Même chose pour `--detach` : sans lui, la stack relancée par le
// planificateur de tâches mourrait avec le terminal.

import { describe, it, expect } from 'vitest';
import { migrationGapRefusal } from '../commands/up.ts';

describe('le refus de servir une base à trous @cap:installer-et-demarrer/moteur', () => {
  it('NOMME chaque migration manquante', () => {
    const texte = migrationGapRefusal(
      [{ tag: '0114_code_projects_init_git' }, { tag: '0118_something_else' }],
      { dev: false, detach: false },
    );
    expect(texte).toContain('0114_code_projects_init_git');
    expect(texte).toContain('0118_something_else');
    expect(texte).toContain('missing 2 migrations');
  });

  it('accorde le singulier sur une seule', () => {
    const texte = migrationGapRefusal([{ tag: '0114_code_projects_init_git' }], {
      dev: false,
      detach: false,
    });
    expect(texte).toContain('missing 1 migration the journal announces');
    expect(texte).not.toContain('1 migrations');
  });

  it('donne la commande EXACTE, et rend le démarrage qu’on avait', () => {
    // Les deux drapeaux comptent. `--detach` en particulier : le planificateur
    // de tâches qui relance Nodal après un redémarrage appelle exactement
    // `up --detach`, et une commande sans lui rendrait la stack au terminal,
    // où elle mourrait avec lui (passe 1 de la revue).
    const commande = (o: { dev: boolean; detach: boolean }) =>
      migrationGapRefusal([{ tag: '0114_x' }], o)
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.startsWith('nodal-agents'));
    expect(commande({ dev: false, detach: false })).toBe('nodal-agents up --repair-migrations');
    expect(commande({ dev: true, detach: false })).toBe(
      'nodal-agents up --repair-migrations --dev',
    );
    expect(commande({ dev: false, detach: true })).toBe(
      'nodal-agents up --repair-migrations --detach',
    );
    expect(commande({ dev: true, detach: true })).toBe(
      'nodal-agents up --repair-migrations --dev --detach',
    );
  });

  it('dit POURQUOI il refuse, et pas seulement qu’il refuse', () => {
    // « Nodal-Agents will not serve » sans la raison se lit comme un caprice.
    // La raison est le fait : les tables sont amputées, les écritures
    // échoueront.
    const texte = migrationGapRefusal([{ tag: '0114_x' }], { dev: false, detach: false });
    expect(texte).toContain('short of columns the code expects');
    expect(texte).toContain('will not serve');
  });
});
