// rendu.test.mjs — ce que la page DIT, rendue pour de vrai.
//
// Pourquoi ce fichier existe (revue de la PR #113, 3e passe) : le portail avait
// trois endroits pour répondre à « combien de parcours ne sont joués par
// personne » — la page Journeys, l'alerte, et la carte d'ensemble. Les deux
// premiers passaient par `etatDunParcours` ; la troisième faisait sa propre
// soustraction. Sous un workflow illisible, les deux premiers ne montraient
// aucun rouge pendant que la carte annonçait « 30 never played ».
//
// Une définition unique dans `lib.mjs` ne suffit donc pas : il faut que la page
// la lise. C'est ce que ces tests vérifient, sur le HTML que `build.mjs` écrit
// vraiment, à partir d'un instantané fabriqué. Aucune lecture de source ne
// prouverait la même chose.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const lire = (chemin) => readFileSync(new URL(chemin, import.meta.url), 'utf8');

/**
 * TOUT ce que `build.mjs` importe du dossier, et qu'il faut donc copier.
 *
 * Même piège que pour le collecteur : un module manquant tue le `beforeAll` et
 * vitest range ses cas en « ignorés » au milieu d'un run vert. Le premier test
 * ci-dessous compare cette liste aux imports réels du renderer.
 */
const MODULES_DU_BAC = ['build.mjs', 'lib.mjs', 'explications.mjs', 'capacites.mjs', 'porte.mjs'];

/** Un parcours, réduit à ce dont la page a besoin pour le ranger et le peindre. */
const parcours = (nom, extra = {}) => ({
  fichier: `apps/web/tests/e2e/${nom}`,
  nom,
  cas: 3,
  jouParLaCi: false,
  cadence: null,
  ciIllisible: false,
  resultat: null,
  intention: 'a journey',
  ...extra,
});

/** Un instantané réduit : juste assez pour que `build.mjs` aille au bout. */
const INSTANTANE = (parcoursListe, ci) => ({
  genereLe: '2026-09-16T03:17:00.000Z',
  tableauLe: '2026-09-16T03:17:00.000Z',
  commit: 'abcd1234',
  branche: 'main',
  execution: null,
  paquets: [],
  resume: {
    paquets: 0,
    fichiersDeTest: 0,
    casDeTest: 0,
    specsE2e: parcoursListe.length,
    casE2e: parcoursListe.length * 3,
    specsE2eJoueesParLaCi: parcoursListe.filter((p) => p.jouParLaCi).length,
    paquetsMesures: 0,
    lignesCouvertes: 0,
    lignesTotal: 0,
    couvertureLignes: null,
    capacites: 0,
    capacitesVerifiees: 0,
    capacitesSansMoteur: 0,
    capacitesSansPreuve: 0,
    testsEnMemoire: 0,
    testsInstables: 0,
    testsCasses: 0,
  },
  capacites: { registre: [], fautes: [], nonDeclarees: [] },
  memoire: { total: 0, instables: 0, casses: 0, pires: [], regressions: [] },
  banc: { sections: [], dernierRun: null, attendu: false },
  ci,
  parcours: parcoursListe,
  prixCi: null,
  chantiers: { issues: [], pr: [], cartes: [] },
});

let bac;
let app;

/** Écrit l'instantané, lance le VRAI renderer, rend le HTML produit. */
function rendre(snapshot) {
  writeFileSync(join(app, 'data', 'snapshot.json'), JSON.stringify(snapshot), 'utf8');
  execSync(`node "${join(app, 'build.mjs')}"`, { encoding: 'utf8' });
  return readFileSync(join(app, 'dist', 'index.html'), 'utf8');
}

/** Le texte de la carte d'ensemble, sans ses balises. */
function carteDesParcours(html) {
  const i = html.indexOf('Journeys played by the CI');
  expect(i).toBeGreaterThan(-1);
  return html.slice(i, i + 700).replace(/<[^>]+>/g, ' ');
}

beforeAll(() => {
  bac = mkdtempSync(join(tmpdir(), 'qa-rendu-'));
  app = join(bac, 'apps', 'qa');
  mkdirSync(join(app, 'data'), { recursive: true });
  for (const f of MODULES_DU_BAC) cpSync(new URL(`./${f}`, import.meta.url), join(app, f));
  writeFileSync(join(app, 'data', 'history.ndjson'), '', 'utf8');
});

afterAll(() => rmSync(bac, { recursive: true, force: true }));

describe('le bac à sable du renderer porte tout ce que le renderer importe', () => {
  it('aucun module local de build.mjs ne manque à la copie', () => {
    const source = lire('./build.mjs');
    const importes = [...source.matchAll(/from\s+'\.\/([\w.-]+\.mjs)'/g)].map((m) => m[1]);
    expect(importes.length).toBeGreaterThan(0);
    for (const m of importes) expect(MODULES_DU_BAC).toContain(m);
  });
});

describe('la carte d’ensemble parle la même langue que la page Journeys', () => {
  const workflow = (fichier, extra = {}) => ({
    fichier,
    nom: fichier,
    declencheurs: ['pull_request'],
    jobs: ['build'],
    specsNommees: [],
    balayeLesParcours: false,
    parcoursExclus: [],
    parcoursIllisibles: false,
    cadence: 'every pull request',
    lanceBanc: true,
    lanceCouverture: true,
    ...extra,
  });
  const CI_LISIBLE = [workflow('.github/workflows/ci.yml')];
  const CI_ILLISIBLE = [workflow('.github/workflows/qa.yml', { parcoursIllisibles: true })];

  it('des parcours que personne ne joue : la carte le dit, et elle alerte', () => {
    const html = rendre(INSTANTANE([parcours('a.spec.ts'), parcours('b.spec.ts')], CI_LISIBLE));
    const carte = carteDesParcours(html);
    expect(carte).toContain('2 never played');
  });

  it('un workflow ILLISIBLE : la carte ne dit PAS « never played »', () => {
    // La mutation du lot : la carte recalculait `specsE2e -
    // specsE2eJoueesParLaCi`, donc « 2 never played » en rouge, pendant que la
    // page Journeys et l'alerte ne montraient aucun rouge. Trois endroits, deux
    // réponses.
    const html = rendre(
      INSTANTANE(
        [
          parcours('a.spec.ts', { ciIllisible: true }),
          parcours('b.spec.ts', { ciIllisible: true }),
        ],
        CI_ILLISIBLE,
      ),
    );
    const carte = carteDesParcours(html);
    expect(carte).not.toContain('never played');
    expect(carte).toContain('a workflow cannot be read');
    // Et la page Journeys les range bien sous leur propre titre, pas en rouge.
    expect(html).toContain('workflow unreadable');
  });

  it('tous joués : la carte ne crie pas, et n’invente pas de rouge', () => {
    const html = rendre(
      INSTANTANE(
        [
          parcours('a.spec.ts', { jouParLaCi: true, cadence: 'every pull request' }),
          parcours('b.spec.ts', { jouParLaCi: true, cadence: 'every night' }),
        ],
        CI_LISIBLE,
      ),
    );
    const carte = carteDesParcours(html);
    expect(carte).toContain('every one of them played');
    expect(carte).not.toContain('never played');
  });
});
