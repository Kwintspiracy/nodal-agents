// rendu.test.mjs — ce que la PAGE montre, lu sur la page.
//
// Deux lots ont eu besoin du même moyen, et ce fichier est leur point de
// rencontre.
//
// « Faits vérifiés » (#120) : les mécanismes étaient prouvés dans `lib.mjs` et
// affichés par `build.mjs`, mais le rendu n'était vérifié qu'en CHERCHANT des
// chaînes dans le source du script. Supprimer le paragraphe qui nomme les
// cartes « already on npm », ou la condition `OPEN` de la pastille « no
// verified facts », laissait la suite verte : le texte cherché restait écrit
// ailleurs dans le fichier.
//
// « Parcours morts » (#113) : le portail avait trois endroits pour répondre à
// « combien de parcours ne sont joués par personne » — la page Journeys,
// l'alerte, et la carte d'ensemble. Les deux premiers passaient par
// `etatDunParcours` ; la troisième faisait sa propre soustraction. Sous un
// workflow illisible, les deux premiers ne montraient aucun rouge pendant que
// la carte annonçait « 30 never played ». Une définition unique dans `lib.mjs`
// ne suffit donc pas : il faut que la page la lise.
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

const lireSource = (nom) => readFileSync(new URL(`./${nom}`, import.meta.url), 'utf8');

/**
 * TOUT ce que le renderer a besoin de trouver à côté de lui.
 *
 * Le piège, déjà payé une fois : un module manquant ne fait PAS rougir ces
 * tests. Le `beforeAll` meurt sur l'import et vitest range ses cas en
 * « ignorés », au milieu d'un run vert — trois preuves éteintes sans un mot,
 * constaté le 16/09 en extrayant `depot.mjs` du collecteur. Le premier test
 * ci-dessous suit les imports de `build.mjs` EN PROFONDEUR et compare.
 */
const MODULES_DU_BAC = ['build.mjs', 'lib.mjs', 'explications.mjs', 'capacites.mjs', 'porte.mjs'];

/** Les modules locaux qu'un fichier importe, et ceux que ceux-là importent. */
function modulesAtteints(depuis) {
  const vus = new Set();
  const aVoir = [depuis];
  while (aVoir.length > 0) {
    const nom = aVoir.pop();
    if (vus.has(nom)) continue;
    vus.add(nom);
    for (const m of lireSource(nom).matchAll(/from\s+'\.\/([\w.-]+\.mjs)'/g)) aVoir.push(m[1]);
  }
  return vus;
}

/** L'instantané committé, dont seules les parties sous test sont refaites. */
const SOCLE = JSON.parse(readFileSync(new URL('./data/snapshot.json', import.meta.url), 'utf8'));

const carte = (o) => ({
  type: 'issue',
  etat: 'OPEN',
  colonne: 'To do',
  url: 'https://github.com/x/y/issues/1',
  etiquettes: [],
  ...o,
});

/**
 * L'instant où ce rendu tourne, à une heure près.
 *
 * Depuis #176, « Done » est une FENÊTRE de sept jours : une carte finie se
 * montre parce qu'elle vient d'être finie, et une carte sans date de fin se
 * replie. Les fixtures finies portent donc une date relative au rendu, et non
 * une date en dur qui sortirait de la fenêtre dès la semaine suivante.
 */
const TOUT_A_LHEURE = new Date(Date.now() - 3600_000).toISOString();

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
    finiLe: TOUT_A_LHEURE,
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
  for (const f of MODULES_DU_BAC) cpSync(new URL(`./${f}`, import.meta.url), join(app, f));
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

describe('le bac à sable du renderer porte tout ce que le renderer atteint', () => {
  it('aucun module local, même indirect, ne manque à la copie', () => {
    const atteints = modulesAtteints('build.mjs');
    expect(atteints.size).toBeGreaterThan(1);
    for (const m of atteints) expect(MODULES_DU_BAC).toContain(m);
  });
});

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

// ─── La carte d'ensemble des parcours (#113) ──────────────────────────────────

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

/** Le socle, dont SEULS les parcours et les workflows sont refaits. */
const avecParcours = (liste, ci) => ({
  ...INSTANTANE,
  ci,
  parcours: liste,
  resume: {
    ...INSTANTANE.resume,
    specsE2e: liste.length,
    casE2e: liste.length * 3,
    specsE2eJoueesParLaCi: liste.filter((p) => p.jouParLaCi).length,
  },
});

/** Le texte de la carte d'ensemble, sans ses balises. */
function carteDesParcours(html) {
  const i = html.indexOf('Journeys played by the CI');
  expect(i, 'carte des parcours absente de la page').toBeGreaterThan(-1);
  return html.slice(i, i + 700).replace(/<[^>]+>/g, ' ');
}

describe('la carte d’ensemble parle la même langue que la page Journeys', () => {
  const CI_LISIBLE = [workflow('.github/workflows/ci.yml')];
  const CI_ILLISIBLE = [workflow('.github/workflows/qa.yml', { parcoursIllisibles: true })];

  it('des parcours que personne ne joue : la carte le dit, et elle alerte', () => {
    const html = rendre(avecParcours([parcours('a.spec.ts'), parcours('b.spec.ts')], CI_LISIBLE));
    expect(carteDesParcours(html)).toContain('2 never played');
  });

  it('un workflow ILLISIBLE : la carte ne dit PAS « never played »', () => {
    // La mutation du lot : la carte recalculait `specsE2e -
    // specsE2eJoueesParLaCi`, donc « 2 never played » en rouge, pendant que la
    // page Journeys et l'alerte ne montraient aucun rouge. Trois endroits, deux
    // réponses.
    const html = rendre(
      avecParcours(
        [
          parcours('a.spec.ts', { ciIllisible: true }),
          parcours('b.spec.ts', { ciIllisible: true }),
        ],
        CI_ILLISIBLE,
      ),
    );
    const bloc = carteDesParcours(html);
    expect(bloc).not.toContain('never played');
    expect(bloc).toContain('a workflow cannot be read');
    // Et la page Journeys les range bien sous leur propre titre, pas en rouge.
    expect(html).toContain('workflow unreadable');
  });

  it('tous joués : la carte ne crie pas, et n’invente pas de rouge', () => {
    const html = rendre(
      avecParcours(
        [
          parcours('a.spec.ts', { jouParLaCi: true, cadence: 'every pull request' }),
          parcours('b.spec.ts', { jouParLaCi: true, cadence: 'every night' }),
        ],
        CI_LISIBLE,
      ),
    );
    const bloc = carteDesParcours(html);
    expect(bloc).toContain('every one of them played');
    expect(bloc).not.toContain('never played');
  });
});

describe('où en est la revue, SUR la carte (#128)', () => {
  // Le tableau disait « In review » et rien d'autre. Les trois cartes d'un même
  // travail — la PR et les issues qu'elle ferme — doivent dire la même chose,
  // et cette chose doit être lue, jamais tapée.

  const REVUE_OK = {
    passes: 2,
    lastReviewer: 'Reviewer C',
    lastDate: '2026-09-18',
    lastVerdict: 'approve',
    counts: { blocking: 0, important: 0, minor: 4 },
    status: 'approved-waiting-merge',
    warnings: [],
  };
  const REVUE_KO = {
    passes: 1,
    lastReviewer: 'Reviewer C',
    lastDate: '2026-09-17',
    lastVerdict: 'request_changes',
    counts: { blocking: 1, important: 2, minor: 3 },
    status: 'changes-requested',
    warnings: [],
  };

  /** Le HTML d'une carte, jusqu'à la fin de son lien. */
  const ticket = (html, tete) => {
    const debut = html.indexOf(`${tete}</span>`);
    expect(debut, `carte ${tete} absente de la page`).toBeGreaterThan(-1);
    return html.slice(debut, html.indexOf('</a>', debut));
  };

  let html = '';
  beforeAll(() => {
    html = rendre({
      ...INSTANTANE,
      chantiers: {
        ...(SOCLE.chantiers ?? {}),
        cartes: [
          carte({
            type: 'pr',
            numero: 200,
            titre: 'The board shows where a review stands',
            colonne: 'In review',
            revue: REVUE_OK,
          }),
          carte({
            numero: 128,
            titre: 'Board says nothing',
            parPr: 200,
            colonne: 'In review',
            revue: REVUE_OK,
          }),
          carte({
            type: 'pr',
            numero: 201,
            titre: 'A PR the reviewer sent back',
            colonne: 'In review',
            revue: REVUE_KO,
          }),
          carte({
            type: 'pr',
            numero: 202,
            titre: 'A PR nobody has opened yet',
            colonne: 'In review',
            revue: { ...REVUE_OK, passes: 0, status: 'in-review', counts: null, lastVerdict: null },
          }),
          carte({
            type: 'pr',
            numero: 203,
            titre: 'A PR already merged',
            etat: 'MERGED',
            colonne: 'Done',
            finiLe: TOUT_A_LHEURE,
            revue: REVUE_OK,
          }),
        ],
      },
    });
  });

  it('la carte de la PR porte la passe, le relecteur, la date et les comptes', () => {
    const t = ticket(html, 'PR #200');
    expect(t).toContain(
      'Pass 2 · Reviewer C · 2026-09-18 · approve (0 blocking, 0 important, 4 minor)',
    );
    expect(t).toContain('approved, waiting for merge');
  });

  it('l’issue que cette PR ferme dit la MÊME chose, à côté de son étiquette PR', () => {
    const t = ticket(html, '#128');
    expect(t).toContain('PR #200');
    expect(t).toContain('approved, waiting for merge');
    expect(t).toContain(
      'Pass 2 · Reviewer C · 2026-09-18 · approve (0 blocking, 0 important, 4 minor)',
    );
  });

  it('une PR renvoyée le dit, et ne passe pas pour approuvée', () => {
    const t = ticket(html, 'PR #201');
    expect(t).toContain('changes requested');
    expect(t).toContain('(1 blocking, 2 important, 3 minor)');
    expect(t).not.toContain('approved, waiting for merge');
  });

  it('une PR que personne n’a encore relue le dit en gris, sans ligne de passe', () => {
    const t = ticket(html, 'PR #202');
    expect(t).toContain('not reviewed yet');
    expect(t).not.toContain('Pass ');
  });

  it('une PR DÉJÀ MERGÉE ne porte plus « waiting for merge »', () => {
    const t = ticket(html, 'PR #203');
    expect(t).not.toContain('approved, waiting for merge');
    expect(t).not.toContain('Pass 2');
  });
});

describe('ce que le portail n’a pas su lire de la revue, il le dit (revue C de #175)', () => {
  it('une carte dont l’état de revue porte un avertissement le montre', () => {
    const html = rendre({
      ...INSTANTANE,
      chantiers: {
        ...(SOCLE.chantiers ?? {}),
        cartes: [
          carte({
            type: 'pr',
            numero: 300,
            titre: 'A PR whose review state could not be fully read',
            colonne: 'In review',
            revue: {
              passes: 0,
              lastReviewer: null,
              lastDate: null,
              lastVerdict: null,
              counts: null,
              status: 'in-review',
              warnings: ['comment list of PR #300 reached 100: a later review pass may be missing'],
            },
          }),
        ],
      },
    });
    const debut = html.indexOf('PR #300</span>');
    expect(debut).toBeGreaterThan(-1);
    const t = html.slice(debut, html.indexOf('</a>', debut));
    expect(t).toContain('review state partly unreadable');
    // La carte dit les DEUX choses : rien de lu, et une raison de s'en méfier.
    expect(t).toContain('not reviewed yet');
  });
});

describe('« Done » est une fenêtre, et les PR mergées y sont (#176)', () => {
  // Le 16/09/2026 : huit issues fermées et six PR mergées le même jour. La
  // colonne en montrait huit, par numéro décroissant, donc aucune des PR.
  const ilYA = (heures) => new Date(Date.now() - heures * 3600_000).toISOString();

  const JOURNEE = [
    ...Array.from({ length: 8 }, (_, k) =>
      carte({
        numero: 109 + k,
        titre: `Closed issue ${k}`,
        etat: 'CLOSED',
        colonne: 'Done',
        finiLe: ilYA(k + 1),
      }),
    ),
    ...[103, 112, 113, 114, 118, 120].map((n, k) =>
      carte({
        type: 'pr',
        numero: n,
        titre: `Merged PR ${n}`,
        etat: 'MERGED',
        colonne: 'Done',
        finiLe: ilYA(k + 1.5),
      }),
    ),
    // Et l'histoire d'avant, qui doit se replier sans faire de bruit.
    ...Array.from({ length: 61 }, (_, k) =>
      carte({
        numero: 10 + k,
        titre: `Old closed issue ${k}`,
        etat: 'CLOSED',
        colonne: 'Done',
        finiLe: new Date(Date.now() - (30 + k) * 86_400_000).toISOString(),
      }),
    ),
  ];

  let html = '';
  beforeAll(() => {
    html = rendre({
      ...INSTANTANE,
      chantiers: { ...(SOCLE.chantiers ?? {}), cartes: JOURNEE },
    });
  });

  it('les six PR mergées du jour sont SUR la page', () => {
    for (const n of [103, 112, 113, 114, 118, 120]) {
      expect(html, `PR #${n} absente`).toContain(`PR #${n}</span>`);
    }
  });

  it('les quatorze cartes du jour sont montrées, et le reste est replié sous son compte', () => {
    const colonne = html.slice(html.indexOf('>Done<'), html.indexOf('>Abandoned<'));
    expect(colonne.match(/class="ticket /g) ?? []).toHaveLength(14);
    expect(colonne).toContain('+ 61 older');
    expect(colonne).toContain('last 7 days, newest first');
  });

  it('la colonne compte TOUT, même ce qu’elle ne montre pas', () => {
    const colonne = html.slice(html.indexOf('>Done<'), html.indexOf('>Abandoned<'));
    expect(colonne).toContain('<span class="compte">75</span>');
  });

  it('les cartes se suivent du plus récemment fini au plus ancien', () => {
    const colonne = html.slice(html.indexOf('>Done<'), html.indexOf('>Abandoned<'));
    const numeros = [...colonne.matchAll(/>(?:PR )?#(\d+)<\/span>/g)].map((m) => Number(m[1]));
    // Une heure sépare chaque carte : l'ordre attendu est donc connu d'avance,
    // et il ENTRELACE les deux familles.
    expect(numeros).toEqual([109, 103, 110, 112, 111, 113, 112, 114, 113, 118, 114, 120, 115, 116]);
  });
});

describe('ce que la colonne DIT de ce qu’elle replie (revue C de #188)', () => {
  it('nomme séparément les plus anciennes et celles qu’elle ne sait pas dater', () => {
    const vieille = (n) =>
      carte({
        numero: n,
        titre: `Old ${n}`,
        etat: 'CLOSED',
        colonne: 'Done',
        finiLe: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      });
    const html = rendre({
      ...INSTANTANE,
      chantiers: {
        ...(SOCLE.chantiers ?? {}),
        cartes: [
          carte({
            numero: 1,
            titre: 'Closed yesterday',
            etat: 'CLOSED',
            colonne: 'Done',
            finiLe: new Date(Date.now() - 86_400_000).toISOString(),
          }),
          vieille(2),
          vieille(3),
          carte({ numero: 4, titre: 'Closed, date unknown', etat: 'CLOSED', colonne: 'Done' }),
        ],
      },
    });
    const colonne = html.slice(html.indexOf('>Done<'), html.indexOf('>Abandoned<'));
    expect(colonne).toContain('+ 2 older, 1 with no closing date');
    expect(colonne).not.toContain('+ 3 older');
  });
});
