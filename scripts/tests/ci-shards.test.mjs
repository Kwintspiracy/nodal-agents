// ci-shards.test.mjs — aucune suite de tests ne tombe entre les tranches de la CI.
//
// Voir scripts/lib/ci-shards.mjs pour le pourquoi. Ce fichier prouve les règles
// sur des workflows écrits exprès (chaque défaut est un constat), puis sur le
// VRAI ci.yml et les VRAIS paquets du dépôt.
//
// Lancer depuis la racine : pnpm test:scripts

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  constats,
  lireCommande,
  lireTranches,
  paquetsAvecTests,
  paquetsDeLaTranche,
} from '../lib/ci-shards.mjs';

const racine = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CI = readFileSync(join(racine, '.github', 'workflows', 'ci.yml'), 'utf-8');
const TURBO = 'pnpm exec turbo run test --continue=dependencies-successful';

/** Un ci.yml minimal : le job `test` et sa matrice, une tranche par commande. */
function workflow(tranches) {
  const lignes = tranches.flatMap(([nom, commande]) => [
    `          - shard: ${nom}`,
    `            run: ${commande}`,
  ]);
  return [
    'jobs:',
    '  test:',
    '    strategy:',
    '      matrix:',
    '        include:',
    ...lignes,
    '    name: test',
    '  build:',
    '    steps: []',
    '',
  ].join('\n');
}

const WEB = '@x/web';
const RUNNER = '@x/runner';
const TOUS = [WEB, RUNNER, '@x/a', '@x/b', '@x/c'];
const COUPES = [WEB, RUNNER];
const BONNES = [
  ['web-1', `${TURBO} --filter=${WEB} -- --shard=1/2`],
  ['web-2', `${TURBO} --filter=${WEB} -- --shard=2/2`],
  ['runner-1', `${TURBO} --filter=${RUNNER} -- --shard=1/2`],
  ['runner-2', `${TURBO} --filter=${RUNNER} -- --shard=2/2`],
  ['p-1', `${TURBO} --filter=@x/a`],
  ['p-2', `${TURBO} --filter=!${WEB} --filter=!${RUNNER} --filter=!@x/a`],
];

/** Les mêmes tranches, avec celle de ce nom réécrite. */
const avec = (nom, commande) => BONNES.map(([n, c]) => (n === nom ? [n, commande] : [n, c]));
const sans = (nom) => BONNES.filter(([n]) => n !== nom);

describe('constats, sur des workflows écrits exprès', () => {
  it('des tranches complètes ne donnent aucun constat', () => {
    expect(constats(workflow(BONNES), TOUS, COUPES)).toEqual([]);
  });

  it('une tranche de paquets écrite en liste, qui oublie un paquet : il est perdu', () => {
    const yml = workflow(avec('p-2', `${TURBO} --filter=@x/b`));
    expect(constats(yml, TOUS, COUPES)).toEqual([
      '@x/c: aucune tranche ne le lance (suite perdue, CI verte à tort)',
    ]);
  });

  it('la tranche par exclusion rattrape un paquet ajouté plus tard', () => {
    expect(constats(workflow(BONNES), [...TOUS, '@x/neuf'], COUPES)).toEqual([]);
  });

  it('un paquet nommé par deux tranches est lancé deux fois : constat', () => {
    const yml = workflow(avec('p-2', `${TURBO} --filter=!${WEB} --filter=!${RUNNER}`));
    expect(constats(yml, TOUS, COUPES)).toEqual(['@x/a: lancé par 2 tranches (p-1, p-2)']);
  });

  it('web dont une moitié manque : constat', () => {
    expect(constats(workflow(sans('web-2')), TOUS, COUPES)).toEqual([
      '@x/web: ses tranches (web-1) portent [1/2], attendu [1/2, 2/2]',
    ]);
  });

  it('web lancé deux fois sur la même moitié : constat', () => {
    const yml = workflow(avec('web-2', `${TURBO} --filter=${WEB} -- --shard=1/2`));
    expect(constats(yml, TOUS, COUPES)).toEqual([
      '@x/web: ses tranches (web-1, web-2) portent [1/2, 1/2], attendu [1/2, 2/2]',
    ]);
  });

  it('runner lancé en entier ET en moitiés : constat', () => {
    const yml = workflow([...BONNES, ['runner-tout', `${TURBO} --filter=${RUNNER}`]]);
    expect(constats(yml, TOUS, COUPES)).toEqual([
      '@x/runner: ses tranches (runner-1, runner-2, runner-tout) portent [1/2, 2/2, entier], attendu [1/2, 2/2]',
    ]);
  });

  it('une moitié vitest sur une tranche de paquets jetterait des fichiers en silence : constat', () => {
    const yml = workflow(avec('p-1', `${TURBO} --filter=@x/a -- --shard=1/2`));
    expect(constats(yml, TOUS, COUPES)).toEqual([
      'p-1: `--shard=1/2` sur une tranche qui lance @x/a',
    ]);
  });

  it('un filtre qui ne nomme aucun paquet du dépôt (faute de frappe) est un constat, jamais un vert', () => {
    const yml = workflow(avec('p-1', `${TURBO} --filter=@x/aa`));
    const c = constats(yml, TOUS, COUPES);
    expect(c).toContain(
      'p-1: ci-shards: le filtre « @x/aa » ne nomme aucun paquet à tests du dépôt',
    );
  });

  it('un filtre que le lecteur ne comprend pas est un constat', () => {
    const yml = workflow(avec('p-1', `${TURBO} --filter=...@x/a`));
    expect(constats(yml, TOUS, COUPES)[0]).toMatch(/filtre turbo non lu « \.\.\.@x\/a »/);
  });

  it('sans job `test` ou sans tranche, le lecteur le dit', () => {
    expect(constats('jobs:\n  build:\n    steps: []\n', TOUS, COUPES)[0]).toMatch(
      /job `test` est introuvable/,
    );
    expect(constats('jobs:\n  test:\n    name: t\n', TOUS, COUPES)[0]).toMatch(/aucune tranche/);
  });
});

describe('lireCommande / paquetsDeLaTranche', () => {
  it('lit les filtres et la moitié passée à vitest', () => {
    expect(lireCommande(`${TURBO} --filter=@x/a --filter=!@x/b -- --shard=2/2`)).toEqual({
      inclus: ['@x/a'],
      exclus: ['@x/b'],
      moitie: '2/2',
    });
  });

  it('des filtres positifs seuls : ces paquets ; négatifs seuls : tous sauf eux', () => {
    expect(paquetsDeLaTranche({ inclus: ['@x/a'], exclus: [] }, TOUS)).toEqual(['@x/a']);
    expect(paquetsDeLaTranche({ inclus: [], exclus: ['@x/a', WEB] }, TOUS)).toEqual([
      RUNNER,
      '@x/b',
      '@x/c',
    ]);
  });
});

describe('le VRAI ci.yml, contre les VRAIS paquets du dépôt', () => {
  const paquets = paquetsAvecTests(racine);
  const noms = paquets.map((p) => p.nom);

  it('la garde voit bien les paquets et les tranches (sinon elle ne garde rien)', () => {
    expect(paquets.length).toBeGreaterThan(30);
    expect(noms).toContain('@nodal-agents/web');
    expect(noms).toContain('@nodal-agents/runner');
    expect(noms).toContain('@nodal-agents/tools');
    expect(paquets.map((p) => p.dossier)).toContain('packages/adapters/gmail');
    expect(lireTranches(CI).map((t) => t.tranche)).toEqual([
      'web-1',
      'web-2',
      'runner-1',
      'runner-2',
      'packages-1',
      'packages-2',
    ]);
  });

  it('chaque paquet à tests est lancé par exactement une tranche, web et runner par leurs deux moitiés', () => {
    expect(constats(CI, noms)).toEqual([]);
  });

  it('un paquet neuf, que personne n’a listé, tombe dans la tranche par exclusion', () => {
    expect(constats(CI, [...noms, '@nodal-agents/neuf'])).toEqual([]);
  });

  it('MUTATION : la tranche 2 réécrite en liste qui oublie des paquets fait rougir la garde', () => {
    const enListe = CI.replace(
      /run: pnpm exec turbo run test --continue=dependencies-successful --filter=!@nodal-agents\/web .*\n/,
      'run: pnpm exec turbo run test --continue=dependencies-successful --filter=@nodal-agents/orchestration\n',
    );
    expect(enListe).not.toBe(CI);
    const c = constats(enListe, noms);
    expect(c).toContain(
      '@nodal-agents/db: aucune tranche ne le lance (suite perdue, CI verte à tort)',
    );
  });

  it('MUTATION : un paquet de la tranche 1 absent de l’exclusion de la 2 est lancé deux fois', () => {
    const deux = CI.replace(' --filter=!@nodal-agents/bench', '');
    expect(deux).not.toBe(CI);
    expect(constats(deux, noms)).toEqual([
      '@nodal-agents/bench: lancé par 2 tranches (packages-1, packages-2)',
    ]);
  });

  it('MUTATION : une moitié de web retirée fait rougir la garde', () => {
    const sansMoitie = CI.replace(/ {10}- shard: web-2\n {12}run: .*\n/, '');
    expect(sansMoitie).not.toBe(CI);
    expect(constats(sansMoitie, noms)).toEqual([
      '@nodal-agents/web: ses tranches (web-1) portent [1/2], attendu [1/2, 2/2]',
    ]);
  });
});
