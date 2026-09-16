// rendu.test.mjs — ce que la PAGE montre, lu sur la page.
//
// Les mécanismes du lot « faits vérifiés » étaient prouvés dans `lib.mjs` et
// affichés par `build.mjs` — mais le rendu, lui, n'était vérifié qu'en
// CHERCHANT des chaînes dans le source du script. Supprimer le paragraphe qui
// nomme les cartes « already on npm », ou la condition `OPEN` de la pastille
// « no verified facts », laissait la suite verte : le texte cherché restait
// écrit ailleurs dans le fichier.
//
// Le portail est donc RENDU pour de vrai, dans une copie jetable, à partir d'un
// instantané fabriqué ici, et les assertions portent sur le HTML produit. Le
// faire tourner dans le dépôt écraserait `apps/qa/dist` et les données
// committées : d'où le bac à sable, comme pour `collect.mjs`.

import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/** L'instantané committé, dont seules la release et les cartes sont refaites. */
const SOCLE = JSON.parse(readFileSync(new URL('./data/snapshot.json', import.meta.url), 'utf8'));

const carte = (o) => ({
  type: 'issue',
  etat: 'OPEN',
  colonne: 'To do',
  url: 'https://github.com/x/y/issues/1',
  etiquettes: [],
  ...o,
});

/** Les cartes qui exercent les deux rendus, et rien d'autre : la page est lisible. */
const CARTES = [
  carte({ numero: 68, titre: 'Publish 0.8.9 to npm' }),
  carte({ numero: 70, titre: 'Agent card with no proof', parUnAgent: true, faitsVerifies: false }),
  carte({ numero: 71, titre: 'Agent card that proved it', parUnAgent: true, faitsVerifies: true }),
  carte({
    numero: 72,
    titre: 'Closed agent card with no proof',
    etat: 'CLOSED',
    colonne: 'Done',
    parUnAgent: true,
    faitsVerifies: false,
  }),
  carte({ numero: 73, titre: 'Human card with no proof', parUnAgent: false, faitsVerifies: false }),
];

const INSTANTANE = {
  ...SOCLE,
  release: {
    npmInjoignable: false,
    verifieLe: '2026-09-16T00:00:00.000Z',
    surNpm: '0.8.9',
    publieeLe: '2026-09-09T12:00:00.000Z',
    versionDuDepot: '0.8.10',
    dernierTag: 'v0.8.9',
    commitsDepuisLeTag: 14,
    depotEnAvance: true,
  },
  chantiers: { ...(SOCLE.chantiers ?? {}), cartes: CARTES },
};

const bac = mkdtempSync(join(tmpdir(), 'qa-rendu-'));
let page = '';
let rendus = 0;

/** Rend le portail POUR DE VRAI sur cet instantané, et rend son HTML. */
const rendre = (instantane) => {
  const app = join(bac, `rendu-${(rendus += 1)}`, 'apps', 'qa');
  mkdirSync(join(app, 'data'), { recursive: true });
  for (const f of ['build.mjs', 'lib.mjs', 'explications.mjs', 'capacites.mjs']) {
    cpSync(new URL(`./${f}`, import.meta.url), join(app, f));
  }
  writeFileSync(join(app, 'data', 'snapshot.json'), JSON.stringify(instantane));
  execFileSync(process.execPath, [join(app, 'build.mjs')], { encoding: 'utf8' });
  return readFileSync(join(app, 'dist', 'index.html'), 'utf8');
};

/** Le HTML de la carte #n, jusqu'à la fin de son lien : les pastilles y sont. */
const ticketDe = (numero) => {
  const debut = page.indexOf(`>#${numero}<`);
  expect(debut, `carte #${numero} absente de la page`).toBeGreaterThan(-1);
  return page.slice(debut, page.indexOf('</a>', debut));
};

beforeAll(() => {
  page = rendre(INSTANTANE);
});

afterAll(() => rmSync(bac, { recursive: true, force: true }));

describe('le bloc Release, sur la page', () => {
  it('montre les trois chiffres lus, pas un verdict', () => {
    expect(page).toContain('latest on npm, published');
    expect(page).toContain('version in the repo');
    expect(page).toContain('commits on main since v0.8.9');
  });

  // Le cas #68 : c'est CE paragraphe qui dit tout haut ce que le tableau
  // portait en silence. Sans lui la page affiche trois chiffres exacts et
  // laisse la carte fautive tranquille.
  it('NOMME la carte ouverte qui demande de publier une version déjà sur npm', () => {
    expect(page).toContain('asks to publish a version already on npm');
    expect(page).toContain('#68 Publish 0.8.9 to npm');
  });

  it('accorde le pluriel sur le nombre de cartes fautives', () => {
    expect(page).toContain('1 open card asks to publish');
    expect(page).not.toContain('cards ask to publish');
  });
});

// Les trois absences du bloc Release, chacune RENDUE. Elles n'étaient couvertes
// que par un grep du source de build.mjs, qui ne dit rien de ce que la page
// affiche : une absence peinte en vert passait inaperçue.
describe('le bloc Release quand npm n’a rien donné', () => {
  const avec = (release) => rendre({ ...INSTANTANE, release });

  it('npm muet : le trou est dit, AVEC son heure, et rien n’est affirmé', () => {
    const p = avec({
      npmInjoignable: true,
      jamaisPubliee: false,
      verifieLe: '2026-09-16T08:30:00.000Z',
      surNpm: null,
      publieeLe: null,
      versionDuDepot: '0.8.10',
      dernierTag: 'v0.8.9',
      commitsDepuisLeTag: 14,
      depotEnAvance: null,
    });
    expect(p).toContain('npm unreachable at');
    // L'heure du constat est DITE, et lisiblement : ni vide, ni l'ISO brut.
    // Le format dépend du fuseau, donc on lit le segment plutôt qu'une date.
    const dit = p.slice(
      p.indexOf('npm unreachable at'),
      p.indexOf('</b>', p.indexOf('npm unreachable at')),
    );
    expect(dit).toMatch(/\b2026\b/);
    expect(dit).not.toContain('2026-09-16T08:30');
    expect(p).toContain('0.8.10');
    expect(p).not.toContain('latest on npm, published');
  });

  // npm a répondu « ce nom n'existe pas » : le dire en « unreachable »
  // accuserait le réseau d'un fait que le registre vient d'établir.
  it('jamais publié : npm a RÉPONDU, et la page ne parle pas de panne', () => {
    const p = avec({
      npmInjoignable: false,
      jamaisPubliee: true,
      verifieLe: '2026-09-16T08:30:00.000Z',
      surNpm: null,
      publieeLe: null,
      versionDuDepot: '0.1.0',
      dernierTag: null,
      commitsDepuisLeTag: null,
      depotEnAvance: true,
    });
    expect(p).toContain('Not published on npm yet');
    expect(p).toContain('0.1.0');
    expect(p).not.toContain('npm unreachable at');
  });

  it('mesure antérieure au contrôle : la page dit qu’elle ne sait pas', () => {
    const sansRelease = { ...INSTANTANE };
    delete sansRelease.release;
    const p = rendre(sansRelease);
    expect(p).toContain('Release state not collected.');
    expect(p).not.toContain('latest on npm, published');
  });
});

describe('la pastille « no verified facts », sur la carte', () => {
  it('marque la carte OUVERTE d’un agent qui n’apporte aucun fait', () => {
    expect(ticketDe(70)).toContain('no verified facts');
  });

  it('laisse tranquille l’agent qui a vérifié, et la carte humaine', () => {
    expect(ticketDe(71)).not.toContain('no verified facts');
    expect(ticketDe(73)).not.toContain('no verified facts');
  });

  // Une carte fermée ne se reproche plus rien : la pastille sur une colonne
  // « Done » transformerait l'historique en dette permanente.
  it('ne marque PAS la carte fermée, même sans fait vérifié', () => {
    expect(ticketDe(72)).not.toContain('no verified facts');
  });
});
