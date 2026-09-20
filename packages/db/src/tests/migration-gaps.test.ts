// migration-gaps.test.ts — la règle qui repère une migration SAUTÉE (#298).
//
// @cap:installer-et-demarrer/moteur
//
// Le migrateur de drizzle ne garde que la DERNIÈRE ligne d'historique et
// n'applique une entrée que si son `when` la dépasse. Une migration mergée
// après une plus récente est donc passée en silence, définitivement. Le
// 20/09/2026 c'est arrivé sur la base du propriétaire : 0114 est arrivée
// après que 0115 eut été appliquée, et toute écriture dans `code_projects` a
// échoué ensuite sur une colonne qui n'existait pas.
//
// Ce fichier prouve la RÈGLE, sans base : un journal de quatre, un historique
// de trois, et le trou nommé. La réparation contre un vrai Postgres est dans
// `migration-gap-repair.pg.test.ts`.
//
// Mutation vérifiée : la comparaison de `gapsBetween` passée de `when` à
// `idx` → le premier cas rougit, parce qu'un historique ne porte pas d'`idx`.

import { describe, it, expect } from 'vitest';
import { gapsBetween } from '../migrate.ts';

/** Quatre entrées de journal, telles que `meta/_journal.json` les écrit. */
const JOURNAL = [
  { idx: 113, when: 1_786_000_860_000, tag: '0113_something' },
  { idx: 114, when: 1_786_000_920_000, tag: '0114_code_projects_init_git' },
  { idx: 115, when: 1_786_000_980_000, tag: '0115_verification_runs_source' },
  { idx: 116, when: 1_786_001_040_000, tag: '0116_job_failure_hint' },
];

describe('gapsBetween @cap:installer-et-demarrer/moteur', () => {
  it('nomme la migration que l’historique n’a jamais reçue', () => {
    // L'historique réel de la base du propriétaire le 20/09 : 113, 115, 116,
    // et 114 absente entre les deux. C'est exactement le cas que drizzle ne
    // peut plus rattraper tout seul.
    const trous = gapsBetween(JOURNAL, [1_786_000_860_000, 1_786_000_980_000, 1_786_001_040_000]);
    expect(trous).toEqual([
      { idx: 114, tag: '0114_code_projects_init_git', when: 1_786_000_920_000 },
    ]);
  });

  it('ne voit AUCUN trou quand les quatre sont là', () => {
    expect(
      gapsBetween(
        JOURNAL,
        JOURNAL.map((e) => e.when),
      ),
    ).toEqual([]);
  });

  it('nomme les DEUX trous quand il y en a deux, dans l’ordre du journal', () => {
    // L'ordre compte : la réparation rejoue les migrations dans cet ordre, et
    // 0114 peut créer la table que 0115 modifie.
    const trous = gapsBetween(JOURNAL, [1_786_000_860_000, 1_786_001_040_000]);
    expect(trous.map((t) => t.tag)).toEqual([
      '0114_code_projects_init_git',
      '0115_verification_runs_source',
    ]);
  });

  it('LIT un historique rendu en chaînes — `created_at` est un bigint', () => {
    // postgres.js rend `bigint` en `string`. Comparer sans convertir donnait
    // 117 trous sur une base parfaitement à jour, ce qui aurait fait
    // désactiver le contrôle le lendemain.
    const enChaines = JOURNAL.map((e) => String(e.when) as unknown as number);
    expect(gapsBetween(JOURNAL, enChaines)).toEqual([]);
  });

  it('IGNORE une ligne d’historique qu’aucune entrée du journal ne réclame', () => {
    // Une base qui porte une migration retirée du dépôt n'est pas une base à
    // trous. Le contrôle ne regarde QUE le sens journal → historique : il dit
    // « il manque ceci », jamais « il y a ceci en trop », qui serait une autre
    // question et une autre réparation.
    const trous = gapsBetween(JOURNAL, [...JOURNAL.map((e) => e.when), 1_700_000_000_000]);
    expect(trous).toEqual([]);
  });

  it('rend TOUT le journal quand rien n’a été appliqué', () => {
    expect(gapsBetween(JOURNAL, []).map((t) => t.idx)).toEqual([113, 114, 115, 116]);
  });
});
