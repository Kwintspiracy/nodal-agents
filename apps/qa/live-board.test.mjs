// live-board.test.mjs — le tableau est vivant, les mesures restent datées de la nuit.
//
// Le portail publié affichait l'état GitHub de la dernière mesure nocturne :
// une issue fermée à 14:05 restait « To do » jusqu'au lendemain 03:17.
// Le remède n'est pas de remesurer à chaque événement — la mesure complète
// instrumente 34 paquets et joue 30 parcours — mais de rafraîchir la SEULE
// part que GitHub sait donner en une seconde, et de la DATER à part.
//
// Une seule date mentirait : elle vieillirait la moitié fraîche, ou
// rajeunirait la moitié mesurée. D'où deux horodatages, et ces tests.

import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fusionnerTableauGitHub } from './lib.mjs';

const lire = (chemin) => readFileSync(new URL(chemin, import.meta.url), 'utf8');

/** Une mesure nocturne, réduite à ce qui compte ici. */
const MESURE = () => ({
  genereLe: '2026-09-15T03:17:00.000Z',
  tableauLe: '2026-09-15T03:17:00.000Z',
  commit: 'abcd1234',
  branche: 'main',
  execution: { id: '111', url: 'https://github.com/x/y/actions/runs/111' },
  resume: { casDeTest: 4200, couvertureLignes: 71.5 },
  capacites: { registre: [{ slug: 'a' }], fautes: [] },
  memoire: { total: 10, casses: 1 },
  banc: { sections: [{ id: 'architecture' }], dernierRun: null, attendu: true },
  ci: [{ fichier: '.github/workflows/ci.yml' }],
  parcours: [{ nom: 'x.spec.ts', resultat: { verts: 3 } }],
  paquets: [{ nom: '@nodal-agents/db' }],
  prixCi: { runs: 30, medianeMin: 7 },
  chantiers: { issues: [], pr: [], cartes: [{ numero: 1, colonne: 'To do' }] },
});

const FRAIS = {
  chantiers: { issues: [], pr: [], cartes: [{ numero: 1, colonne: 'Done' }] },
  prixCi: { runs: 30, medianeMin: 9 },
  le: '2026-09-15T14:05:00.000Z',
};

describe('rafraîchir la part GitHub sans toucher aux mesures', () => {
  it('garde À L’IDENTIQUE tout ce qui vient d’une mesure', () => {
    const avant = MESURE();
    const apres = fusionnerTableauGitHub(avant, FRAIS);
    for (const cle of [
      'genereLe',
      'commit',
      'branche',
      'execution',
      'resume',
      'capacites',
      'memoire',
      'banc',
      'ci',
      'parcours',
      'paquets',
    ]) {
      expect(apres[cle], `${cle} a bougé`).toEqual(avant[cle]);
    }
  });

  it('remplace le tableau par celui de GitHub', () => {
    const apres = fusionnerTableauGitHub(MESURE(), FRAIS);
    expect(apres.chantiers.cartes[0].colonne).toBe('Done');
    expect(apres.prixCi.medianeMin).toBe(9);
  });

  it('date le tableau du moment de la collecte, pas de la mesure', () => {
    const apres = fusionnerTableauGitHub(MESURE(), FRAIS);
    expect(apres.tableauLe).toBe('2026-09-15T14:05:00.000Z');
    expect(apres.genereLe).toBe('2026-09-15T03:17:00.000Z');
  });

  it('GitHub muet : le tableau committé reste, et sa date ne rajeunit pas', () => {
    // Écraser par un tableau ABSENT publierait un portail vide à chaque
    // hoquet d'API ; avancer la date ferait passer l'ancien pour du neuf.
    const apres = fusionnerTableauGitHub(MESURE(), { chantiers: null, prixCi: null, le: FRAIS.le });
    expect(apres.chantiers.cartes[0].colonne).toBe('To do');
    expect(apres.tableauLe).toBe('2026-09-15T03:17:00.000Z');
  });

  it('prix de la CI absent : l’ancien est gardé plutôt qu’effacé', () => {
    const apres = fusionnerTableauGitHub(MESURE(), { ...FRAIS, prixCi: null });
    expect(apres.prixCi.medianeMin).toBe(7);
    expect(apres.chantiers.cartes[0].colonne).toBe('Done');
  });

  it('sans mesure committée, on échoue fort plutôt que d’inventer un socle', () => {
    expect(() => fusionnerTableauGitHub(null, FRAIS)).toThrow();
  });

  it('une mesure sans `tableauLe` hérite de sa date de mesure', () => {
    const avant = MESURE();
    delete avant.tableauLe;
    const apres = fusionnerTableauGitHub(avant, { chantiers: null, prixCi: null, le: FRAIS.le });
    expect(apres.tableauLe).toBe('2026-09-15T03:17:00.000Z');
  });
});

/**
 * TOUT ce que `collect.mjs` importe du dossier, et qu'il faut donc copier.
 *
 * En oublier un ne fait PAS rougir les trois tests ci-dessous : le `beforeAll`
 * meurt sur l'import manquant et vitest range ses cas en « ignorés », au milieu
 * d'un run vert. Constaté le 16/09 en extrayant `depot.mjs` — trois preuves
 * éteintes sans un mot. Le test qui suit la liste compare celle-ci aux imports
 * réels du collecteur, pour que l'oubli suivant soit rouge.
 */
const MODULES_DU_BAC = ['collect.mjs', 'lib.mjs', 'depot.mjs', 'capacites.mjs', 'porte.mjs'];

describe('le bac à sable du collecteur porte tout ce que le collecteur importe', () => {
  it('aucun module local de collect.mjs ne manque à la copie', () => {
    const source = lire('./collect.mjs');
    const importes = [...source.matchAll(/from\s+'\.\/([\w.-]+\.mjs)'/g)].map((m) => m[1]);
    expect(importes.length).toBeGreaterThan(0);
    for (const m of importes) expect(MODULES_DU_BAC).toContain(m);
  });
});

describe('le collecteur sait ne rafraîchir que GitHub', () => {
  // Le mode est joué POUR DE VRAI, dans une copie jetable, avec un `gh` qui
  // refuse de répondre. C'est le chemin le plus dur : GitHub muet. Il prouve
  // les deux promesses d'un coup, qu'aucune lecture de source ne prouverait —
  // rien n'est écrasé, et ni l'historique ni la mémoire des tests ne bougent.
  const MEMOIRE = `{"titre":"un test"}\n`;
  let sortie = '';
  const bac = mkdtempSync(join(tmpdir(), 'qa-live-'));
  const app = join(bac, 'apps', 'qa');
  const data = join(app, 'data');

  beforeAll(() => {
    mkdirSync(data, { recursive: true });
    for (const f of MODULES_DU_BAC) {
      cpSync(new URL(`./${f}`, import.meta.url), join(app, f));
    }
    writeFileSync(join(data, 'snapshot.json'), JSON.stringify(MESURE(), null, 2));
    writeFileSync(join(data, 'history.ndjson'), '{"le":"2026-09-15T03:17:00.000Z"}\n');
    writeFileSync(join(data, 'tests.ndjson'), MEMOIRE);
    // Un `gh` qui échoue, en tête du PATH. Sans lui le test appellerait le
    // vrai GitHub et son résultat changerait d'une minute à l'autre.
    const bin = join(bac, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexit 1\n`, { mode: 0o755 });
    writeFileSync(join(bin, 'gh.cmd'), `@exit /b 1\r\n`);
    sortie = execSync(`node "${join(app, 'collect.mjs')}" --github-only`, {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
    });
  });

  afterAll(() => rmSync(bac, { recursive: true, force: true }));

  it('il n’ajoute AUCUNE ligne d’historique', () => {
    const lignes = readFileSync(join(data, 'history.ndjson'), 'utf8').trim().split(`\n`);
    expect(lignes).toHaveLength(1);
  });

  it('il ne touche pas à la mémoire des tests', () => {
    expect(readFileSync(join(data, 'tests.ndjson'), 'utf8')).toBe(MEMOIRE);
  });

  it('GitHub muet : la mesure committée sort intacte, et il le dit', () => {
    const apres = JSON.parse(readFileSync(join(data, 'snapshot.json'), 'utf8'));
    expect(apres.chantiers.cartes[0].colonne).toBe('To do');
    expect(apres.genereLe).toBe(MESURE().genereLe);
    expect(apres.resume).toEqual(MESURE().resume);
    expect(sortie).toContain('NOT refreshed');
  });
});

describe('le portail publié se rafraîchit sur les événements GitHub', () => {
  const docs = lire('../../.github/workflows/docs.yml');
  const qa = lire('../../.github/workflows/qa.yml');

  it('docs.yml rafraîchit la part GitHub avant de rendre', () => {
    // Les lignes `run:` et elles seules : un commentaire qui NOMME la commande
    // passait pour la commande elle-même, et supprimer l'étape laissait la
    // garde verte. C'est la faute que ce dépôt connaît déjà par les étiquettes
    // `@cap:` lues dans des commentaires.
    const commandes = [...docs.matchAll(/^\s*run:\s*(.+)$/gm)].map((m) => m[1]);
    const iCollecte = commandes.findIndex((c) => c.includes('collect.mjs --github-only'));
    const iRendu = commandes.findIndex((c) => c.includes('build.mjs'));
    expect(iCollecte).toBeGreaterThan(-1);
    expect(iRendu).toBeGreaterThan(iCollecte);
  });

  /**
   * Les types d'UN déclencheur, lus sous son nom.
   *
   * Le test lisait `docs.toContain(type)` sur le fichier ENTIER : `unlabeled`
   * et `edited`, présents dans la liste des issues, le rendaient vert alors que
   * les pull requests ne les portaient pas (#178). Un mot trouvé quelque part
   * n'est pas un mot trouvé au bon endroit — la même faute que les étiquettes
   * `@cap:` lues dans un commentaire.
   */
  const typesDe = (declencheur) => {
    // Le bloc `on:` SEUL : `issues:` reparaît sous `permissions:`, où il ne dit
    // pas du tout la même chose.
    const on = docs.slice(0, docs.indexOf('\npermissions:'));
    const bloc = on.slice(on.indexOf(`\n  ${declencheur}:`));
    const apres = bloc.slice(bloc.indexOf('types:') + 'types:'.length);
    // LES DEUX FORMES YAML, parce que le fichier porte les deux : `[a, b]` tant
    // que la ligne tient, une liste à tirets au-delà — prettier replie la
    // première, et l'analyseur des docs ne sait pas lire un repli.
    const crochets = apres.match(/^[ \t]*\[([^\]]+)\]/);
    if (crochets) return crochets[1].split(',').map((t) => t.trim());
    const types = [];
    for (const ligne of apres.split('\n').slice(1)) {
      const item = ligne.match(/^\s+-\s+([\w_]+)\s*$/);
      if (!item) break;
      types.push(item[1]);
    }
    return types;
  };

  it('docs.yml écoute les issues et les pull requests', () => {
    for (const evenement of ['issues:', 'pull_request_target:']) {
      expect(docs).toContain(evenement);
    }
    // Pas `pull_request` : l'environnement `github-pages` n'autorise que
    // `main`, et le déploiement échouait sur chaque pull request. Une case
    // rouge permanente finit par ne plus être lue.
    expect(docs).not.toMatch(/^\s{2}pull_request:/m);
  });

  it('les DEUX déclencheurs republient sur les mêmes mouvements de carte', () => {
    // Le tableau lit l'état, les étiquettes et le CORPS des deux familles — le
    // « Closes #n » vit dans le corps. Poser une étiquette et la retirer
    // doivent donc republier pareil.
    for (const declencheur of ['issues', 'pull_request_target']) {
      const types = typesDe(declencheur);
      for (const type of ['opened', 'closed', 'reopened', 'labeled', 'unlabeled', 'edited']) {
        expect(types, `${declencheur} n’écoute pas ${type}`).toContain(type);
      }
    }
    // Ce qui n'appartient qu'aux pull requests.
    expect(typesDe('pull_request_target')).toContain('ready_for_review');
    expect(typesDe('pull_request_target')).toContain('converted_to_draft');
  });

  it('n’écoute PAS `synchronize` : un rendu complet à chaque poussée', () => {
    // Ce qu'il ferait bouger — l'état des vérifications — bouge tout seul, sans
    // qu'aucun événement ne le dise : c'est le filet horaire qui le rattrape,
    // pas un déploiement par commit.
    expect(typesDe('pull_request_target')).not.toContain('synchronize');
  });

  it('docs.yml garde un filet horaire, à une minute qui n’est pas :00', () => {
    const cron = docs.match(/cron:\s*'(\d+) /);
    expect(cron).not.toBeNull();
    expect(Number(cron[1])).toBeGreaterThan(0);
  });

  it('docs.yml ne committe ni ne pousse rien', () => {
    // Il RÉSOUD, il n'enregistre pas. Un push depuis le rendu ferait de chaque
    // déploiement un commit, et l'historique du portail deviendrait celui des
    // visites plutôt que celui des mesures.
    expect(docs).not.toMatch(/git (commit|push)/);
  });

  it('docs.yml a le droit de LIRE les issues et les pull requests', () => {
    expect(docs).toMatch(/issues:\s*read/);
    expect(docs).toMatch(/pull-requests:\s*read/);
  });

  it('la mesure nocturne reste la seule à écrire les données', () => {
    expect(qa).toMatch(/git push origin HEAD:main/);
  });
});

describe('la page montre les deux dates, en UTC', () => {
  // RENDUE POUR DE VRAI, et depuis un fuseau qui n'est pas UTC. Le test lisait
  // la SOURCE de `build.mjs` et cherchait les mots « measured » et « board as
  // of » : il restait vert pendant que la page rendait l'heure locale de la
  // machine, sans jamais le dire (#178). Le même instantané donnait « 08:37 »
  // sur le runner et « 16:37 » sur le poste du propriétaire.
  //
  // Mutation vérifiée : `timeZone: 'UTC'` retiré de `dateFr` → les deux
  // premiers cas rougissent sous `TZ=Asia/Tokyo`.
  const bac = mkdtempSync(join(tmpdir(), 'qa-dates-'));
  /** Un instant dont l'heure UTC et l'heure de Tokyo tombent des jours différents. */
  const INSTANT = '2026-09-15T23:30:00.000Z';
  let html = '';

  beforeAll(() => {
    const app = join(bac, 'apps', 'qa');
    const data = join(app, 'data');
    mkdirSync(data, { recursive: true });
    for (const f of ['build.mjs', 'lib.mjs', 'capacites.mjs', 'explications.mjs', 'depot.mjs']) {
      cpSync(new URL(`./${f}`, import.meta.url), join(app, f));
    }
    // La VRAIE mesure committée, avec les deux seules dates changées : `build.mjs`
    // rend la page entière et lit bien plus que ce qu'un instantané de test
    // porterait. Le cas montré est celui que les deux dates existent pour dire —
    // un tableau relu bien APRÈS la mesure.
    const snapshot = {
      ...JSON.parse(lire('./data/snapshot.json')),
      genereLe: '2026-09-15T03:17:00.000Z',
      tableauLe: INSTANT,
    };
    writeFileSync(join(data, 'snapshot.json'), JSON.stringify(snapshot, null, 2));
    writeFileSync(join(data, 'history.ndjson'), `{"le":"2026-09-15T03:17:00.000Z"}\n`);
    execSync(`node "${join(app, 'build.mjs')}"`, {
      encoding: 'utf8',
      env: { ...process.env, TZ: 'Asia/Tokyo' },
    });
    html = readFileSync(join(app, 'dist', 'index.html'), 'utf8');
  });

  afterAll(() => rmSync(bac, { recursive: true, force: true }));

  it('date le TABLEAU à l’heure UTC de sa lecture, et le dit', () => {
    // 23:30Z, et non le 08:30 du lendemain que Tokyo aurait affiché.
    expect(html).toContain('board as of 15 Sept 2026, 23:30Z');
    expect(html).not.toContain('16 Sept 2026, 08:30');
  });

  it('date la MESURE à son heure à elle, sans la rajeunir', () => {
    expect(html).toContain('measured 15 Sept 2026, 03:17Z');
  });

  it('montre le tableau AVANT la mesure — c’est lui qui dit si la page est fraîche', () => {
    expect(html.indexOf('board as of')).toBeLessThan(html.indexOf('measured 15 Sept'));
  });

  it('ne laisse AUCUNE heure sans fuseau sur la page', () => {
    // Toute heure rendue par `dateFr` porte son `Z`. Une heure nue se
    // compare à l'œil avec l'heure d'un événement GitHub, qui est en UTC, et
    // un décalage de huit heures passe alors pour de la fraîcheur.
    const heuresNues = [...html.matchAll(/\d{2} \w+ \d{4}, \d{2}:\d{2}(?!Z)/g)];
    expect(heuresNues.map((m) => m[0])).toEqual([]);
  });
});
