// lib.test.mjs — les jugements du portail, prouvés.
//
// Le portail se dénonçait à 0 % de couverture (issue #57). Il avait raison, et
// une revue Codex a trouvé SIX erreurs de jugement dans ces quelques
// fonctions — dont deux qui le faisaient mentir : une CI annulée affichée
// verte, et des cas ignorés comptés comme rouges.
//
// Chaque test ci-dessous nomme le cas réel qui l'a motivé. Un portail qui se
// trompe sur un verdict est pire que pas de portail : il fait croire qu'on
// regarde.

import { describe, it, expect } from 'vitest';
import {
  etatCi,
  colonneDeCarte,
  cartesDuTableau,
  sortDuCas,
  compterParcours,
  parcoursDunWorkflow,
  declencheursDunWorkflow,
  cadenceDe,
  capacitesDunTitre,
  titresDeTest,
  etatDuneCapacite,
  fautesDuRegistre,
  regrouperParCapacite,
  croiserPreuves,
  ecartsDe,
  alertes,
  verdictDuBanc,
  cleDuTest,
  fusionnerEssais,
  instabiliteDe,
  regressionsFraiches,
  dernierSort,
} from './lib.mjs';
import { CAPACITES } from './capacites.mjs';
import { revendicationsDuDepot } from './porte.mjs';
import { corpsDeLalerte, trouverLeBillet } from './alerte.mjs';

describe('etatCi — le vert ne s’accorde qu’à ce qui a réussi', () => {
  it('tout en succès ⇒ vert', () => {
    expect(etatCi([{ conclusion: 'SUCCESS' }, { conclusion: 'SUCCESS' }])).toBe('vert');
  });

  it('un échec ⇒ rouge', () => {
    expect(etatCi([{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }])).toBe('rouge');
  });

  it('ANNULÉ n’est pas vert', () => {
    // Le cas qui a motivé le correctif : le 10/09, quatre exécutions ont été
    // annulées, chaque push remplaçant la précédente. Elles s'affichaient vertes.
    expect(etatCi([{ status: 'COMPLETED', conclusion: 'CANCELLED' }])).toBe('rouge');
  });

  it('DÉLAI DÉPASSÉ et ACTION REQUISE ne sont pas verts non plus', () => {
    expect(etatCi([{ conclusion: 'TIMED_OUT' }])).toBe('rouge');
    expect(etatCi([{ conclusion: 'ACTION_REQUIRED' }])).toBe('rouge');
  });

  it('un état INCONNU n’est jamais vert', () => {
    // Le défaut est le rouge : un tableau qui verdit ce qu'il ne comprend pas
    // ment sur le seul point qui compte.
    expect(etatCi([{ conclusion: 'UN_ETAT_QUE_GITHUB_INVENTERA' }])).toBe('rouge');
  });

  it('un contexte de statut ANCIEN, en attente, n’est pas vert', () => {
    // Les status contexts ne portent pas `status` mais `state` : la première
    // version lisait `status`, ne trouvait rien, et concluait au vert.
    expect(etatCi([{ state: 'PENDING' }])).toBe('en cours');
    expect(etatCi([{ state: 'SUCCESS' }])).toBe('vert');
    expect(etatCi([{ state: 'FAILURE' }])).toBe('rouge');
  });

  it('en cours ⇒ ni vert ni rouge', () => {
    expect(etatCi([{ status: 'IN_PROGRESS' }, { conclusion: 'SUCCESS' }])).toBe('en cours');
  });

  it('aucun contrôle ⇒ rien à dire, pas un verdict', () => {
    expect(etatCi([])).toBeNull();
    expect(etatCi(null)).toBeNull();
  });

  it('NEUTRAL et SKIPPED comptent comme réussis', () => {
    // Un contrôle qui ne s'applique pas n'est pas un échec.
    expect(etatCi([{ conclusion: 'NEUTRAL' }, { conclusion: 'SKIPPED' }])).toBe('vert');
  });
});

describe('colonneDeCarte — déduite de faits', () => {
  it('une PR mergée est faite, une PR ouverte est en review', () => {
    expect(colonneDeCarte({ type: 'pr', etat: 'MERGED' })).toBe('Fait');
    expect(colonneDeCarte({ type: 'pr', etat: 'OPEN' })).toBe('En review');
  });

  it('une PR FERMÉE sans merge n’attend pas de review', () => {
    // La PR #2 de Snyk, fermée sans merge, gonflait la colonne « En review » —
    // qui doit rester un appel à l'action, pas un cimetière.
    expect(colonneDeCarte({ type: 'pr', etat: 'CLOSED' })).toBe('Abandonné');
  });

  it('une issue étiquetée décision attend Quentin', () => {
    expect(colonneDeCarte({ type: 'issue', etat: 'OPEN', etiquettes: ['décision'] })).toBe(
      'À faire',
    );
  });

  it('une issue étiquetée test va dans À tester', () => {
    expect(colonneDeCarte({ type: 'issue', etat: 'OPEN', etiquettes: ['test', 'dette'] })).toBe(
      'À tester',
    );
  });

  it('« décision » prime sur « test » — c’est elle qui bloque', () => {
    expect(colonneDeCarte({ type: 'issue', etat: 'OPEN', etiquettes: ['test', 'décision'] })).toBe(
      'À faire',
    );
  });

  it('une issue ouverte sans étiquette parlante est en cours', () => {
    expect(colonneDeCarte({ type: 'issue', etat: 'OPEN', etiquettes: [] })).toBe('En cours');
    expect(colonneDeCarte({ type: 'issue', etat: 'OPEN' })).toBe('En cours');
  });

  it('une issue fermée est faite', () => {
    expect(colonneDeCarte({ type: 'issue', etat: 'CLOSED', etiquettes: ['décision'] })).toBe(
      'Fait',
    );
  });
});

describe('cartesDuTableau — une requête qui ÉCHOUE n’est pas un tableau vide', () => {
  // Revue Codex du 11/09, P2. Dans la mesure nocturne, `collect.mjs` appelle
  // `gh` sans jeton : les deux requêtes échouent, `?? []` les changeait en
  // listes vides, et le portail publiait chaque nuit un Kanban VIDE par-dessus
  // le vrai. C'est le défaut que ce portail dénonce partout ailleurs — rendre
  // une absence comme un zéro — commis dans son propre collecteur.
  const ISSUE = { number: 1, title: 'a', state: 'OPEN', labels: [], url: 'u' };
  const PR = { number: 2, title: 'b', state: 'OPEN', url: 'v' };

  it('rend null quand les issues n’ont pas pu être lues', () => {
    expect(cartesDuTableau({ issues: null, pr: [PR] })).toBeNull();
  });

  it('rend null quand les PR n’ont pas pu être lues', () => {
    expect(cartesDuTableau({ issues: [ISSUE], pr: null })).toBeNull();
  });

  it('un tableau réellement VIDE reste un tableau vide, pas une absence', () => {
    // La distinction utile : « personne n'a rien ouvert » et « je n'ai pas pu
    // demander » se ressemblent et ne veulent pas dire la même chose.
    expect(cartesDuTableau({ issues: [], pr: [] })).toEqual([]);
  });

  it('mélange issues et PR, chacune avec sa colonne', () => {
    const c = cartesDuTableau({ issues: [ISSUE], pr: [{ ...PR, state: 'MERGED' }] });
    expect(c).toHaveLength(2);
    expect(c.find((x) => x.type === 'issue').colonne).toBe('En cours');
    expect(c.find((x) => x.type === 'pr').colonne).toBe('Fait');
  });
});

describe('sortDuCas — ignoré n’est pas rouge', () => {
  it('un passage du premier coup est vert', () => {
    expect(sortDuCas([{ status: 'passed' }])).toBe('vert');
  });

  it('un échec est rouge', () => {
    expect(sortDuCas([{ status: 'failed' }])).toBe('rouge');
  });

  it('IGNORÉ n’est pas rouge', () => {
    // Le rapport committé porte 36 cas ignorés. Ils s'affichaient tous comme
    // des régressions — le défaut même que ce portail dénonce ailleurs.
    expect(sortDuCas([{ status: 'skipped' }])).toBe('ignoré');
    expect(sortDuCas([])).toBe('ignoré');
  });

  it('passé au SECOND essai est instable, pas vert', () => {
    // Le seul signal qui distingue un test sûr d'un test instable. Le
    // confondre avec un succès, c'est le perdre.
    expect(sortDuCas([{ status: 'failed' }, { status: 'passed' }])).toBe('instable');
  });

  it('un essai ignoré parmi des passages ne change rien', () => {
    expect(sortDuCas([{ status: 'skipped' }, { status: 'passed' }])).toBe('vert');
  });

  it('compterParcours ventile les quatre sorts', () => {
    const c = compterParcours(['vert', 'vert', 'rouge', 'ignoré', 'instable']);
    expect(c).toEqual({ total: 5, vert: 2, rouge: 1, ignoré: 1, instable: 1 });
  });
});

describe('declencheursDunWorkflow — une détection muette qui se trompe répond quand même', () => {
  // Le cas réel : un `\b` écrit depuis un script shell est devenu un caractère
  // de contrôle littéral dans le fichier. La regex cherchait un caractère
  // invisible, ne trouvait jamais rien, et le portail affichait « à la main »
  // pour TOUS les parcours — y compris les deux joués à chaque PR. Rien ne
  // l'a signalé pendant une journée.
  const CI = `name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  ci:
    runs-on: ubuntu-latest`;

  const NOCTURNE = `name: Qualité

on:
  schedule:
    - cron: '17 3 * * *'
  workflow_dispatch:

jobs:
  mesure:
    runs-on: ubuntu-latest`;

  it('lit push et pull_request', () => {
    expect(declencheursDunWorkflow(CI)).toEqual(['push', 'pull_request']);
  });

  it('lit schedule et le déclenchement manuel', () => {
    expect(declencheursDunWorkflow(NOCTURNE)).toEqual(['schedule', 'manuel']);
  });

  it('un fichier sans bloc `on:` ne déclenche rien', () => {
    expect(declencheursDunWorkflow('jobs:\n  ci:\n    runs-on: ubuntu-latest')).toEqual([]);
  });

  it('ne confond pas un `push` de texte avec un déclencheur', () => {
    // `declencheurs.push(...)` dans un commentaire, un `git push` dans un
    // script : ce ne sont pas des déclencheurs. L'ancre en début de ligne est
    // ce qui les distingue.
    const wf = `name: X

on:
  workflow_dispatch:

jobs:
  x:
    steps:
      - run: git push origin main`;
    expect(declencheursDunWorkflow(wf)).toEqual(['manuel']);
  });
});

describe('cadenceDe — garder n’est pas constater', () => {
  it('une PR prime sur tout : c’est la seule cadence qui BLOQUE', () => {
    expect(cadenceDe(['push', 'pull_request', 'schedule'])).toBe('chaque PR');
  });

  it('la nuit constate, elle ne bloque pas', () => {
    expect(cadenceDe(['schedule', 'manuel'])).toBe('chaque nuit');
  });

  it('un push sur main est entre les deux', () => {
    expect(cadenceDe(['push', 'manuel'])).toBe('chaque push sur main');
  });

  it('rien d’automatique ⇒ à la main', () => {
    expect(cadenceDe(['manuel'])).toBe('à la main');
    expect(cadenceDe([])).toBe('à la main');
  });
});

describe('parcoursDunWorkflow — nommés et balayés', () => {
  const TOUS = [
    'smoke.spec.ts',
    'autonomy-approvals.spec.ts',
    'agent-flows.spec.ts',
    'oauth.spec.ts',
  ];

  it('lit les parcours NOMMÉS en toutes lettres', () => {
    const wf = `
      - name: Two journeys
        run: >
          playwright test
          tests/e2e/smoke.spec.ts
          tests/e2e/autonomy-approvals.spec.ts`;
    const r = parcoursDunWorkflow(wf, TOUS);
    expect(r.balaye).toBe(false);
    expect(r.joues.sort()).toEqual(['autonomy-approvals.spec.ts', 'smoke.spec.ts']);
  });

  it('comprend un BALAYAGE et ses exclusions', () => {
    // Sans ça, le portail annonçait « 2 parcours en CI » pour toujours, même
    // une fois la mesure nocturne en place : il affirmait que 28 parcours ne
    // tournent jamais alors qu'ils tournaient chaque nuit.
    const wf = `
      - name: Tous les parcours
        run: |
          mapfile -t specs < <(ls tests/e2e/*.spec.ts | grep -v 'agent-flows.spec.ts')
          npx playwright test "\${specs[@]}"`;
    const r = parcoursDunWorkflow(wf, TOUS);
    expect(r.balaye).toBe(true);
    expect(r.exclus).toEqual(['agent-flows.spec.ts']);
    expect(r.joues.sort()).toEqual([
      'autonomy-approvals.spec.ts',
      'oauth.spec.ts',
      'smoke.spec.ts',
    ]);
  });

  it('un workflow qui ne parle d’aucun parcours n’en joue aucun', () => {
    const r = parcoursDunWorkflow('- run: pnpm typecheck', TOUS);
    expect(r.joues).toEqual([]);
  });
});

// ─── La gravité (issue #65) ───────────────────────────────────────────────────

describe('ecartsDe — le produit passe avant le dépôt', () => {
  const CAP = (etat, exigee = true) => ({
    slug: 'x',
    nom: 'Connecter un service',
    etat,
    exigee,
    preuves: [],
  });
  const SNAP = (extra = {}) => ({
    resume: { specsE2e: 2 },
    capacites: { registre: [] },
    parcours: [],
    paquets: [],
    ci: [],
    ...extra,
  });

  it('une capacité EXIGÉE cassée est haute — c’est une promesse rompue', () => {
    const e = ecartsDe(SNAP({ capacites: { registre: [CAP('rouge')] } }), [{}, {}]);
    expect(e[0].gravite).toBe('haute');
    expect(e[0].titre).toMatch(/capacité\(s\) exigée\(s\) du produit sont cassées/);
    expect(e[0].quoi).toEqual(['Connecter un service']);
  });

  it('les capacités JAMAIS prouvées restent basses — c’est un plan, pas une alerte', () => {
    // Les monter en haute noierait les vraies régressions sous une liste qui
    // ne bouge que lentement. Le bruit décourage d'ouvrir la page.
    const e = ecartsDe(SNAP({ capacites: { registre: [CAP('jamais prouvée', false)] } }), [{}, {}]);
    expect(e).toHaveLength(1);
    expect(e[0].gravite).toBe('basse');
  });

  it('une capacité exigée dont la preuve DORT est moyenne, pas haute', () => {
    // Trou dans la mesure, pas dans le produit : le traiter comme une
    // régression enverrait chercher un bug qui n'existe pas.
    const e = ecartsDe(SNAP({ capacites: { registre: [CAP('non jouée')] } }), [{}, {}]);
    expect(e[0].gravite).toBe('moyenne');
  });

  it('un rouge FRAIS est haut, un rouge ancien ne l’est pas', () => {
    // La distinction qui fait tout le lot : une régression de la nuit se
    // traite, une dette de trois mois se planifie.
    const now = Date.parse('2026-09-10T00:00:00Z');
    const memoire = (jour) => ({
      instables: 0,
      regressions: [{ cle: 'a::b', titre: 'un test', rougeDepuis: jour }],
    });

    const frais = ecartsDe(SNAP({ memoire: memoire('2026-09-09T12:00:00Z') }), [{}, {}], now);
    expect(
      frais.some((x) => x.gravite === 'haute' && /rouge dans les deux derniers/.test(x.titre)),
    ).toBe(true);

    const vieux = ecartsDe(SNAP({ memoire: memoire('2026-06-01T00:00:00Z') }), [{}, {}], now);
    expect(vieux.some((x) => /rouge dans les deux derniers/.test(x.titre))).toBe(false);
  });

  it('une RÉGRESSION FRAÎCHE est vue même quand l’historique la dit instable', () => {
    // Revue Codex du 11/09, P2. Un test qui passait et qui tombe a un historique
    // `vr` : `instabiliteDe` le classe « instable », donc il sortait de
    // `listeCasses` — et `ecartsDe` ne cherchait les rouges frais QUE là. La
    // seule vraie régression que ce lot devait attraper lui échappait, et elle
    // n'apparaissait qu'une fois devenue « cassée », c'est-à-dire trop tard,
    // avec une date déjà trop vieille pour être signalée.
    const now = Date.parse('2026-09-11T00:00:00Z');
    const e = ecartsDe(
      SNAP({
        memoire: {
          instables: 1,
          listeCasses: [],
          regressions: [
            { cle: 'a::b', titre: 'un test qui passait hier', rougeDepuis: '2026-09-10T20:00:00Z' },
          ],
        },
      }),
      [{}, {}],
      now,
    );
    const alerte = e.find((x) => /rouge dans les deux derniers/.test(x.titre));
    expect(alerte?.gravite).toBe('haute');
    expect(alerte?.quoi).toEqual(['un test qui passait hier']);
  });

  it('un cassé SANS date connue ne passe pas pour frais', () => {
    // `Date.parse(null)` rend NaN, et toute comparaison avec NaN est fausse —
    // mais compter sur ça serait un accident. La garde est explicite.
    const e = ecartsDe(
      SNAP({ memoire: { instables: 0, regressions: [{ cle: 'a::b', rougeDepuis: null }] } }),
      [{}, {}],
    );
    expect(e.some((x) => /rouge dans les deux derniers/.test(x.titre))).toBe(false);
  });

  it('une RÉGRESSION DU BANC remonte en haute', () => {
    // Ce branchement-là avait échappé à la mutation : `verdictDuBanc` était
    // testée, mais rien ne prouvait qu'`ecartsDe` la lisait. On pouvait donc
    // débrancher le banc des écarts sans qu'un seul test rougisse.
    const e = ecartsDe(
      SNAP({
        banc: {
          dernierRun: {
            run: { startedAt: '2026-09-11T03:17:00Z' },
            diffs: [{ sectionId: 'architecture', label: 'Architecture', regressed: true }],
          },
        },
      }),
      [{}, {}],
    );
    const x = e.find((y) => /banc ont RÉGRESSÉ/.test(y.titre));
    expect(x?.gravite).toBe('haute');
    expect(x?.quoi).toEqual(['Architecture']);
  });

  it('une section du banc EN PANNE remonte, distincte d’une régression', () => {
    const e = ecartsDe(
      SNAP({ banc: { dernierRun: { diffs: [{ sectionId: 'x', label: 'X', error: 'ENOENT' }] } } }),
      [{}, {}],
    );
    expect(e.find((y) => /n'ont PAS PU tourner/.test(y.titre))?.gravite).toBe('haute');
    expect(e.some((y) => /banc ont RÉGRESSÉ/.test(y.titre))).toBe(false);
  });

  it('un banc qui n’a laissé AUCUN rapport remonte en haute — l’écran le disait, l’alerte se taisait', () => {
    // Troisième passe Codex : `verdictDuBanc(null)` rendait `absent: true`, et
    // `ecartsDe` ne lisait pas ce champ. Le banc pouvait planter avant d'écrire
    // une ligne, et l'alerte fermait son billet comme si tout allait bien.
    const e = ecartsDe(SNAP({ banc: { attendu: true, dernierRun: null } }), [{}, {}]);
    const x = e.find((y) => /banc n'a laissé aucun rapport/.test(y.titre));
    expect(x?.gravite).toBe('haute');
    expect(alertes(e)).toContain(x);
    // Mais seulement quand il était ATTENDU : un rendu local ne le lance pas,
    // et « un banc jamais passé ne crie pas » (plus haut) reste vrai.
    const local = ecartsDe(SNAP({ banc: { attendu: false, dernierRun: null } }), [{}, {}]);
    expect(local.some((y) => /banc/.test(y.titre))).toBe(false);
  });

  it('un banc jamais passé ne crie pas dans les écarts', () => {
    // Absent se dit à l'écran du banc, pas dans la liste des alertes : sinon
    // chaque dépôt neuf partirait avec une alerte permanente.
    expect(ecartsDe(SNAP(), [{}, {}]).some((y) => /banc/.test(y.titre))).toBe(false);
  });

  it('à gravité égale, le PRODUIT est listé avant le dépôt', () => {
    const e = ecartsDe(
      SNAP({
        capacites: { registre: [CAP('rouge')] },
        parcours: [{ nom: 'a.spec.ts', cas: 3, jouParLaCi: false }],
      }),
      [{}, {}],
    );
    const hautes = e.filter((x) => x.gravite === 'haute');
    expect(hautes[0].titre).toMatch(/capacité/);
    expect(hautes[1].titre).toMatch(/parcours/);
  });

  it('trie par gravité, toutes catégories confondues', () => {
    const e = ecartsDe(
      SNAP({
        capacites: { registre: [CAP('jamais prouvée', false), CAP('rouge')] },
        paquets: [{ nom: 'p', tests: { cas: 0, e2e: 0 } }],
      }),
      [{}, {}],
    );
    expect(e.map((x) => x.gravite)).toEqual(
      [...e.map((x) => x.gravite)].sort(
        (a, b) => ({ haute: 0, moyenne: 1, basse: 2 })[a] - { haute: 0, moyenne: 1, basse: 2 }[b],
      ),
    );
  });

  it('un dépôt sans rien à dire ne dit rien', () => {
    expect(ecartsDe(SNAP(), [{}, {}])).toEqual([]);
    expect(ecartsDe(null)).toEqual([]);
    expect(ecartsDe(undefined)).toEqual([]);
  });

  it('un historique d’une seule collecte se signale, en basse', () => {
    const e = ecartsDe(SNAP(), []);
    expect(e).toHaveLength(1);
    expect(e[0].gravite).toBe('basse');
  });
});

describe('verdictDuBanc — une porte qui sort en erreur et que personne ne lit', () => {
  // Revue Codex du 11/09, P2. La mesure nocturne lance le banc avec `|| true`
  // — délibérément, pour enregistrer plutôt que d'arrêter — et range son
  // rapport dans `bench-run.json`. Mais ni l'écran ni `ecartsDe` ne le lisaient :
  // le portail n'affichait que les baselines ACCEPTÉES. Une régression de
  // métrique passait donc la nuit sans un mot, alors même que le banc l'avait
  // détectée et écrite.

  it('rend absent quand aucun rapport n’a été produit', () => {
    // Absent n'est pas « tout va bien » : c'est le trou de mesure que ce portail
    // refuse de peindre en vert.
    expect(verdictDuBanc(null)).toMatchObject({ absent: true, regressions: [], erreurs: [] });
    expect(verdictDuBanc(undefined).absent).toBe(true);
  });

  it('nomme les sections qui ont RÉGRESSÉ', () => {
    const v = verdictDuBanc({
      run: { startedAt: '2026-09-11T03:17:00Z', gitSha: 'abc' },
      diffs: [
        { sectionId: 'architecture', label: 'Architecture', regressed: true, diffs: [] },
        { sectionId: 'contexte', label: 'Contexte', regressed: false, diffs: [] },
      ],
    });
    expect(v.absent).toBe(false);
    expect(v.regressions).toEqual(['Architecture']);
    expect(v.mesureLe).toBe('2026-09-11T03:17:00Z');
  });

  it('une section qui n’a PAS PU tourner est une erreur, pas une régression', () => {
    // Les confondre ferait chercher un ralentissement là où il y a une panne.
    const v = verdictDuBanc({
      diffs: [{ sectionId: 'x', label: 'X', regressed: false, error: 'ENOENT' }],
    });
    expect(v.erreurs).toEqual(['X']);
    expect(v.regressions).toEqual([]);
  });

  it('un rapport sans le moindre écart ne crie pas', () => {
    const v = verdictDuBanc({ diffs: [{ sectionId: 'x', label: 'X', regressed: false }] });
    expect(v).toMatchObject({ absent: false, regressions: [], erreurs: [] });
  });
});

describe('trouverLeBillet — le billet d’alerte doit être RETROUVÉ, pas recréé', () => {
  // Revue Codex du 11/09, P2. La recherche listait les 50 issues ouvertes les
  // plus récentes : passé ce seuil, le billet existant sortait du lot. Une
  // mesure rouge en aurait ouvert un DEUXIÈME, et une mesure propre n'aurait
  // jamais pu fermer le premier.
  it('exige le titre EXACT', () => {
    const l = [
      { number: 1, title: 'Portail : ce qui est rouge — suite' },
      { number: 2, title: 'Portail : ce qui est rouge' },
    ];
    expect(trouverLeBillet(l, 'Portail : ce qui est rouge')?.number).toBe(2);
  });

  it('ne rend rien quand aucun titre ne correspond', () => {
    expect(
      trouverLeBillet([{ number: 9, title: 'autre chose' }], 'Portail : ce qui est rouge'),
    ).toBeNull();
    expect(trouverLeBillet([], 'x')).toBeNull();
    expect(trouverLeBillet(null, 'x')).toBeNull();
  });
});

describe('alertes — seule la gravité haute réveille quelqu’un', () => {
  it('ne garde que les hautes', () => {
    const e = [{ gravite: 'haute' }, { gravite: 'moyenne' }, { gravite: 'basse' }];
    expect(alertes(e)).toEqual([{ gravite: 'haute' }]);
  });

  it('rien à signaler ⇒ liste vide, pas une alerte vide', () => {
    // Une alerte qui part quand tout va bien est une alerte qu'on désactive.
    expect(alertes([{ gravite: 'moyenne' }])).toEqual([]);
    expect(alertes([])).toEqual([]);
    expect(alertes()).toEqual([]);
  });
});

describe('corpsDeLalerte — un billet dont on doute est un billet qu’on ignore', () => {
  const ECART = {
    gravite: 'haute',
    titre: 'Deux capacités sont cassées',
    detail: 'Le test qui les prouve échoue.',
    quoi: ['Connecter un service', 'Approuver ou refuser'],
  };

  it('nomme la collecte qui l’a produit', () => {
    // Sans ça, personne ne peut dire si le billet parle d'aujourd'hui ou d'il y
    // a trois semaines.
    const c = corpsDeLalerte([ECART], {
      le: '2026-09-10T22:00:00Z',
      commit: 'abc1234',
      branche: 'main',
    });
    expect(c).toContain('2026-09-10T22:00:00Z');
    expect(c).toContain('abc1234');
    expect(c).toContain('main');
  });

  it('liste ce qui est touché', () => {
    const c = corpsDeLalerte([ECART], {});
    expect(c).toContain('Connecter un service');
    expect(c).toContain('Approuver ou refuser');
  });

  it('BORNE la liste — sinon le billet devient le bruit qu’il remplaçait', () => {
    const c = corpsDeLalerte(
      [{ ...ECART, quoi: Array.from({ length: 40 }, (_, i) => `t${i}`) }],
      {},
    );
    expect(c).toContain('t14');
    expect(c).not.toContain('t15');
    expect(c).toContain('et 25 autres');
  });

  it('un écart sans détail nommé ne fabrique pas de liste vide', () => {
    const c = corpsDeLalerte([{ ...ECART, quoi: [] }], {});
    expect(c).toContain('Deux capacités sont cassées');
    expect(c).not.toMatch(/^- /m);
  });

  it('une collecte sans métadonnées ne laisse pas « undefined » dans le billet', () => {
    const c = corpsDeLalerte([ECART]);
    expect(c).not.toContain('undefined');
  });
});

// ─── La mémoire, test par test (issue #64) ────────────────────────────────────

describe('fusionnerEssais — ce qui n’a pas tourné ne bouge pas', () => {
  const T = (titre, sort, le) => ({ fichier: 'a.spec.ts', titre, sort, le });

  it('ouvre un enregistrement pour un test jamais vu', () => {
    const r = fusionnerEssais([], [T('un', 'vert', '2026-09-01')]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ cle: 'a.spec.ts::un', tours: 1, echecs: 0, recents: 'v' });
  });

  it('un test connu ABSENT de la salve garde ses compteurs', () => {
    // La règle qu'on oublie. Une exécution ne joue presque jamais toute la
    // suite : compter un tour pour un test qui n'a pas tourné ferait mentir
    // tous les taux, et compter un échec serait pire.
    const avant = fusionnerEssais([], [T('un', 'vert'), T('deux', 'rouge')]);
    const apres = fusionnerEssais(avant, [T('un', 'vert')]);
    const deux = apres.find((e) => e.cle === 'a.spec.ts::deux');
    expect(deux).toMatchObject({ tours: 1, echecs: 1, recents: 'r' });
    expect(apres.find((e) => e.cle === 'a.spec.ts::un')).toMatchObject({ tours: 2, recents: 'vv' });
  });

  it('compte les échecs et retient QUAND', () => {
    let r = fusionnerEssais([], [T('un', 'vert', '2026-08-31')]);
    r = fusionnerEssais(r, [T('un', 'rouge', '2026-09-01')]);
    r = fusionnerEssais(r, [T('un', 'rouge', '2026-09-02')]);
    expect(r[0]).toMatchObject({
      tours: 3,
      echecs: 2,
      recents: 'vrr',
      dernierEchecLe: '2026-09-02',
      rougeDepuis: '2026-09-01',
    });
  });

  it('un test INCONNU trouvé rouge n’est pas daté — on ne l’a jamais vu vert', () => {
    // La première collecte a présenté vingt-deux rouges anciens comme des
    // régressions du jour. « Passé au rouge » suppose une transition observée ;
    // sans elle, la date serait celle où on a commencé à regarder.
    const r = fusionnerEssais([], [T('un', 'rouge', '2026-09-10')]);
    expect(r[0]).toMatchObject({ echecs: 1, rougeDepuis: null, dernierEchecLe: '2026-09-10' });
  });

  it('un rouge qui SUCCÈDE à un rouge ne rajeunit pas le problème', () => {
    // L'erreur inverse, et la plus insidieuse : dater chaque nuit ferait
    // paraître neuf un test cassé depuis trois mois, et une dette passerait
    // éternellement pour une régression du jour.
    let r = fusionnerEssais([], [T('un', 'rouge', '2026-09-01')]);
    expect(r[0].rougeDepuis).toBeNull();
    r = fusionnerEssais(r, [T('un', 'rouge', '2026-09-02')]);
    expect(r[0].rougeDepuis).toBeNull();
  });

  it('la date arrive à la BASCULE, et à elle seule', () => {
    let r = fusionnerEssais([], [T('un', 'rouge', '2026-09-01')]);
    r = fusionnerEssais(r, [T('un', 'vert', '2026-09-05')]);
    r = fusionnerEssais(r, [T('un', 'rouge', '2026-09-06')]);
    expect(r[0].rougeDepuis).toBe('2026-09-06');
  });

  it('`rougeDepuis` est l’âge du problème COURANT, pas du premier de l’histoire', () => {
    // Un test cassé en juillet, réparé, recassé hier a un problème d'un jour.
    // Garder juillet ferait passer une régression fraîche pour une dette
    // ancienne, et l'inverse est tout aussi trompeur.
    let r = fusionnerEssais([], [T('un', 'rouge', '2026-07-01')]);
    r = fusionnerEssais(r, [T('un', 'vert', '2026-08-01')]);
    expect(r[0].rougeDepuis).toBeNull();
    r = fusionnerEssais(r, [T('un', 'rouge', '2026-09-09')]);
    expect(r[0].rougeDepuis).toBe('2026-09-09');
    // La mémoire du dernier échec, elle, ne s'efface jamais.
    expect(r[0].dernierEchecLe).toBe('2026-09-09');
  });

  it('la fenêtre glisse et reste bornée', () => {
    // Sans borne, le fichier grossit sans fin et le dépôt finit par porter
    // l'historique complet de six mille tests.
    let r = [];
    for (let i = 0; i < 10; i++) r = fusionnerEssais(r, [T('un', 'vert')], { max: 4 });
    expect(r[0].recents).toBe('vvvv');
    expect(r[0].tours).toBe(10);
  });

  it('un sort inconnu n’entre pas dans la mémoire', () => {
    // Mieux vaut un trou qu'une lettre inventée sur laquelle on calculera des
    // taux ensuite.
    const r = fusionnerEssais([], [T('un', 'sorti-de-nulle-part'), T('deux', 'vert')]);
    expect(r.map((e) => e.cle)).toEqual(['a.spec.ts::deux']);
  });

  it('deux tests homonymes dans deux fichiers ne fusionnent pas', () => {
    const r = fusionnerEssais(
      [],
      [
        { fichier: 'a.spec.ts', titre: 'ouvre', sort: 'vert' },
        { fichier: 'b.spec.ts', titre: 'ouvre', sort: 'rouge' },
      ],
    );
    expect(r).toHaveLength(2);
    expect(cleDuTest('a.spec.ts', 'ouvre')).toBe('a.spec.ts::ouvre');
  });

  it('deux tests homonymes dans le MÊME fichier, dans la même salve, ne fusionnent pas non plus', () => {
    // Troisième passe Codex : un `test.each` dont le titre ne distingue pas
    // ses paramètres produit deux cas homonymes. Fusionnés, un cas toujours
    // vert et un cas toujours rouge devenaient UN test « instable », avec une
    // régression fraîche inventée à chaque nuit.
    let r = fusionnerEssais([], [T('cas', 'vert', '2026-09-01'), T('cas', 'rouge', '2026-09-01')]);
    expect(r).toHaveLength(2);
    expect(r.map((e) => e.recents)).toEqual(['v', 'r']);
    expect(r.every((e) => e.rougeDepuis === null)).toBe(true);

    // Et la nuit suivante, chacun retrouve SON historique : la clé est stable.
    r = fusionnerEssais(r, [T('cas', 'vert', '2026-09-02'), T('cas', 'rouge', '2026-09-02')]);
    expect(r.map((e) => e.recents)).toEqual(['vv', 'rr']);
    expect(r.map((e) => e.tours)).toEqual([2, 2]);
  });

  it('rend une liste triée — le diff du fichier doit rester lisible', () => {
    const r = fusionnerEssais(
      [],
      [T('z', 'vert'), T('a', 'vert'), T('m', 'vert')].map((x) => x),
    );
    expect(r.map((e) => e.titre)).toEqual(['a', 'm', 'z']);
  });

  it('sans argument, elle ne s’effondre pas', () => {
    expect(fusionnerEssais()).toEqual([]);
    expect(fusionnerEssais([], [])).toEqual([]);
  });
});

describe('regressionsFraiches — indépendantes du verdict d’instabilité', () => {
  it('prend un test qui passait et qui tombe, que l’historique dit « instable »', () => {
    const r = regressionsFraiches([
      { cle: 'a::b', recents: 'vvvr', rougeDepuis: '2026-09-10T20:00:00Z' },
    ]);
    expect(r).toHaveLength(1);
  });

  it('laisse un test REDEVENU vert', () => {
    // Le dernier tour est ce qui compte : un problème réparé n'est plus un
    // problème, même si sa bascule est encore datée dans la fenêtre.
    expect(
      regressionsFraiches([{ recents: 'vrv', rougeDepuis: '2026-09-10T20:00:00Z' }]),
    ).toHaveLength(0);
  });

  it('laisse un rouge dont la bascule n’a JAMAIS été vue', () => {
    // Sans `rougeDepuis`, on ne sait pas quand il a cassé — l'annoncer comme
    // frais reviendrait à dater le jour où on a commencé à regarder.
    expect(regressionsFraiches([{ recents: 'rrr', rougeDepuis: null }])).toHaveLength(0);
  });

  it('ne s’effondre pas sur rien', () => {
    expect(regressionsFraiches()).toEqual([]);
    expect(regressionsFraiches([])).toEqual([]);
  });
});

describe('instabiliteDe — l’instabilité ne se voit QUE dans le temps', () => {
  it('que des verts ⇒ sûr', () => {
    expect(instabiliteDe({ recents: 'vvvvv' })).toMatchObject({ verdict: 'sûr', tauxEchec: 0 });
  });

  it('que des rouges ⇒ cassé, pas instable', () => {
    // Un test qui échoue toujours n'est pas capricieux : il est cassé. Les
    // confondre noierait la vraie instabilité dans la liste des régressions.
    expect(instabiliteDe({ recents: 'rrr' })).toMatchObject({ verdict: 'cassé', tauxEchec: 100 });
  });

  it('un mélange ⇒ INSTABLE, même si le dernier tour est vert', () => {
    // Le cas qui justifie tout ce lot : ce test tombe un jour sur trois. Aucune
    // exécution isolée ne le dénonce, et `sortDuCas` le dirait « vert » à
    // chaque fois qu'il passe.
    const i = instabiliteDe({ recents: 'vvrvvvrvv' });
    expect(i.verdict).toBe('instable');
    expect(i.tauxEchec).toBe(22.2);
    expect(dernierSort({ recents: 'vvrvvvrvv' })).toBe('vert');
  });

  it('une reprise au second essai compte comme instable', () => {
    expect(instabiliteDe({ recents: 'vvfv' }).verdict).toBe('instable');
  });

  it('les tours IGNORÉS ne comptent ni au numérateur ni au dénominateur', () => {
    // Un test qu'on saute n'est ni une réussite ni un échec. Le compter
    // gonflerait la fenêtre et diluerait le taux jusqu'à le rendre muet.
    expect(instabiliteDe({ recents: 'iiivv' })).toMatchObject({ verdict: 'sûr', fenetre: 2 });
    expect(instabiliteDe({ recents: 'iii' })).toMatchObject({ verdict: 'inconnu', fenetre: 0 });
  });

  it('sans mémoire, elle ne prononce rien', () => {
    expect(instabiliteDe({})).toMatchObject({ verdict: 'inconnu', tauxEchec: null });
    expect(instabiliteDe(null)).toMatchObject({ verdict: 'inconnu' });
    expect(dernierSort(null)).toBeNull();
  });
});

// ─── Les capacités du produit (issue #63) ─────────────────────────────────────

describe('capacitesDunTitre — ce qu’un test dit prouver', () => {
  it('lit une étiquette dans un titre de test', () => {
    expect(capacitesDunTitre('crée un agent depuis la page vide @cap:creer-agent')).toEqual([
      'creer-agent',
    ]);
  });

  it('en lit PLUSIEURS — un parcours traverse souvent deux capacités', () => {
    // Refuser la seconde forcerait à couper des parcours utiles en morceaux
    // pour satisfaire le registre. C'est le registre qui doit s'adapter.
    expect(
      capacitesDunTitre('@cap:connecter-un-service puis @cap:assigner-outils sur le même agent'),
    ).toEqual(['connecter-un-service', 'assigner-outils']);
  });

  it('un titre sans étiquette n’en revendique aucune', () => {
    expect(capacitesDunTitre('affiche la liste')).toEqual([]);
    expect(capacitesDunTitre('')).toEqual([]);
    expect(capacitesDunTitre(null)).toEqual([]);
    expect(capacitesDunTitre(undefined)).toEqual([]);
  });

  it('s’arrête au slug et ne mange pas la ponctuation qui suit', () => {
    expect(capacitesDunTitre('@cap:creer-agent, puis autre chose')).toEqual(['creer-agent']);
    expect(capacitesDunTitre('(@cap:voir-le-cout)')).toEqual(['voir-le-cout']);
  });

  it('« @cap: » sans slug ne revendique rien', () => {
    expect(capacitesDunTitre('@cap: creer-agent')).toEqual([]);
  });
});

// Les fixtures ci-dessous contiennent des appels de test À L'INTÉRIEUR de
// chaînes. La porte scanne le dépôt fichier par fichier : si l'étiquette y était
// écrite en toutes lettres, elle lirait ce fichier de test comme s'il déclarait
// de vraies preuves — et accuserait `@cap:a` de ne désigner aucune capacité.
//
// C'est une mutation qui l'a montré, pas une relecture. Le préfixe est donc
// assemblé à l'exécution : aucune regex ne saurait distinguer une fixture d'une
// déclaration, et c'est à la fixture de se dénoncer.
const E = '@' + 'cap';

describe('titresDeTest — une étiquette ne compte que dans un TITRE', () => {
  it('lit describe, it et test, et leurs variantes', () => {
    const src = [
      `describe('un ${E}:a', () => {`,
      `  it.skip('deux ${E}:b', () => {});`,
      `  test.each([1])('trois %i ${E}:c', () => {});`,
      '});',
    ].join('\n');
    expect(titresDeTest(src)).toEqual([`un ${E}:a`, `deux ${E}:b`, `trois %i ${E}:c`]);
  });

  it('IGNORE une étiquette hors d’un titre — le faux positif trouvé par mutation', () => {
    const src = [
      `// voir ${E}:dans-un-commentaire`,
      `const fixture = 'texte ${E}:dans-une-chaine';`,
      `expect(capacitesDunTitre('${E}:dans-un-argument')).toEqual([]);`,
      `it('le vrai ${E}:celle-ci', () => {});`,
    ].join('\n');
    const slugs = titresDeTest(src).flatMap((t) => capacitesDunTitre(t));
    expect(slugs).toEqual(['celle-ci']);
  });

  it('un test COMMENTÉ ne revendique plus rien — sinon désactiver la preuve la laisse valide', () => {
    // Troisième passe Codex : commenter l'unique test d'une capacité laissait
    // sa revendication active, et la porte disait « prouvée » d'un test qui
    // n'existe plus. Ligne commentée, bloc commenté : les deux formes.
    const src = [
      `// it('un ${E}:mort-en-ligne', () => {});`,
      '/*',
      `it('deux ${E}:mort-en-bloc', () => {});`,
      '*/',
      `it('trois ${E}:vivant', () => {});`,
    ].join('\n');
    expect(titresDeTest(src)).toEqual([`trois ${E}:vivant`]);
  });

  it('un titre qui contient une URL n’est pas coupé au « // »', () => {
    // Le nettoyage des commentaires ne doit retirer que les LIGNES commentées :
    // un `//` au milieu d'un titre est un morceau de titre.
    const src = `it('ouvre http://localhost:3000 ${E}:x', () => {});`;
    expect(titresDeTest(src)).toEqual([`ouvre http://localhost:3000 ${E}:x`]);
  });

  it('accepte les trois sortes de guillemets', () => {
    const src = ["it('a', 0)", 'it("b", 0)', 'it(`c`, 0)'].join('\n');
    expect(titresDeTest(src)).toEqual(['a', 'b', 'c']);
  });

  it('ne s’arrête pas sur une apostrophe échappée', () => {
    // Le titre « enable Command execution via the agent's Tools tab » existe
    // pour de vrai dans la suite : couper à l'apostrophe perdrait l'étiquette
    // qui vit après elle.
    const src = `it('l\\'agent ${E}:x', () => {});`;
    expect(capacitesDunTitre(titresDeTest(src)[0])).toEqual(['x']);
  });

  it('ne confond pas un identifiant qui FINIT par test ou it', () => {
    const src = ["monTest('a', 0)", "audit('b', 0)", `it('c ${E}:vrai', 0)`].join('\n');
    expect(titresDeTest(src)).toEqual([`c ${E}:vrai`]);
  });

  it('un fichier sans test ne rend rien', () => {
    expect(titresDeTest('export const x = 1;')).toEqual([]);
    expect(titresDeTest('')).toEqual([]);
    expect(titresDeTest(null)).toEqual([]);
  });
});

describe('etatDuneCapacite — deux trous différents, jamais confondus', () => {
  it('aucun test ne la revendique ⇒ JAMAIS PROUVÉE', () => {
    // La colonne qui compte : la liste de ce qu'on croit livré.
    expect(etatDuneCapacite([])).toBe('jamais prouvée');
    expect(etatDuneCapacite(null)).toBe('jamais prouvée');
  });

  it('un test la revendique mais n’a pas tourné ⇒ NON JOUÉE, pas « jamais prouvée »', () => {
    // La preuve existe et dort. C'est un trou dans la MESURE, pas dans le
    // produit — les confondre ferait réécrire un test qui existe déjà.
    expect(etatDuneCapacite([{ capacite: 'x', origine: 'a.spec.ts' }])).toBe('non jouée');
    expect(etatDuneCapacite([{ sort: 'ignoré' }])).toBe('non jouée');
  });

  it('un test vert ⇒ prouvée, même accompagné d’un test qui n’a pas tourné', () => {
    expect(etatDuneCapacite([{ sort: 'vert' }])).toBe('prouvée');
    expect(etatDuneCapacite([{ sort: null }, { sort: 'vert' }])).toBe('prouvée');
  });

  it('le ROUGE l’emporte sur le vert — pas de moyenne', () => {
    // Une capacité tenue par trois tests dont un échoue est cassée, pas
    // « majoritairement verte ». Une moyenne ici cacherait la seule chose
    // qu'on cherche.
    expect(etatDuneCapacite([{ sort: 'vert' }, { sort: 'vert' }, { sort: 'rouge' }])).toBe('rouge');
  });

  it('l’instabilité l’emporte sur le vert, mais pas sur le rouge', () => {
    expect(etatDuneCapacite([{ sort: 'vert' }, { sort: 'instable' }])).toBe('instable');
    expect(etatDuneCapacite([{ sort: 'instable' }, { sort: 'rouge' }])).toBe('rouge');
  });
});

describe('fautesDuRegistre — la porte garde le LIEN, pas le résultat', () => {
  const REGISTRE = [
    { slug: 'creer-agent', nom: 'Créer un agent', exigee: true },
    { slug: 'voir-le-cout', nom: 'Voir ce que ça coûte', exigee: false },
  ];

  it('une étiquette qui ne désigne rien est une faute, et elle est SITUÉE', () => {
    // Une faute de frappe, ou un slug renommé sans que les tests suivent. Sans
    // ce contrôle l'étiquetage pourrit en trois semaines sans que rien ne le
    // dise — le test continue de passer, il ne prouve simplement plus rien.
    const fautes = fautesDuRegistre({
      capacites: REGISTRE,
      preuves: [
        { capacite: 'creer-agnet', origine: 'agents.spec.ts' },
        { capacite: 'creer-agnet', origine: 'smoke.spec.ts' },
      ],
    });
    // Elle en produit DEUX, et c'est ce qu'il faut : le slug ne désigne rien,
    // et la capacité qu'il visait n'est de ce fait plus prouvée par personne.
    // N'afficher que la première laisserait croire à une coquille cosmétique.
    expect(fautes).toEqual([
      {
        type: 'étiquette inconnue',
        slug: 'creer-agnet',
        origines: ['agents.spec.ts', 'smoke.spec.ts'],
      },
      { type: 'capacité exigée sans preuve', slug: 'creer-agent', nom: 'Créer un agent' },
    ]);
  });

  it('une capacité EXIGÉE que plus aucun test ne revendique est une faute', () => {
    // Le cas du test supprimé ou renommé qui emporte la preuve avec lui.
    const fautes = fautesDuRegistre({ capacites: REGISTRE, preuves: [] });
    expect(fautes).toEqual([
      { type: 'capacité exigée sans preuve', slug: 'creer-agent', nom: 'Créer un agent' },
    ]);
  });

  it('une capacité NON exigée sans preuve ne bloque pas', () => {
    // La vague s'élargit à mesure que les parcours sont étiquetés. Une porte
    // qui exige tout le premier jour se fait désactiver le deuxième.
    const fautes = fautesDuRegistre({
      capacites: REGISTRE,
      preuves: [{ capacite: 'creer-agent', origine: 'a.spec.ts' }],
    });
    expect(fautes).toEqual([]);
  });

  it('une capacité exigée dont les tests ÉCHOUENT ne fait pas faute ICI', () => {
    // Contrat explicite : cette porte tourne sur les PR, où aucun résultat e2e
    // complet n'existe. Elle ne juge que les DÉCLARATIONS. Prétendre qu'elle
    // protège du rouge en ferait une garde imaginaire — la gravité d'un rouge
    // est le sujet de l'issue #65.
    const fautes = fautesDuRegistre({
      capacites: REGISTRE,
      preuves: [{ capacite: 'creer-agent', origine: 'a.spec.ts', sort: 'rouge' }],
    });
    expect(fautes).toEqual([]);
  });

  it('sans argument, elle ne s’effondre pas et n’accuse personne', () => {
    expect(fautesDuRegistre()).toEqual([]);
    expect(fautesDuRegistre({})).toEqual([]);
  });
});

describe('regrouperParCapacite — l’ordre du registre est l’écran', () => {
  it('attache son état et ses preuves à chaque capacité, dans l’ordre', () => {
    const r = regrouperParCapacite({
      capacites: [
        { slug: 'a', domaine: 'X', exigee: true },
        { slug: 'b', domaine: 'X', exigee: false },
      ],
      preuves: [{ capacite: 'a', origine: 'un.spec.ts', sort: 'vert' }],
    });
    expect(r.map((c) => c.slug)).toEqual(['a', 'b']);
    expect(r[0].etat).toBe('prouvée');
    expect(r[0].preuves).toHaveLength(1);
    expect(r[1].etat).toBe('jamais prouvée');
    expect(r[1].preuves).toEqual([]);
  });

  it('ne trie PAS par état — sinon la page cesse de dire ce que le produit sait faire', () => {
    const r = regrouperParCapacite({
      capacites: [
        { slug: 'vert', domaine: 'X' },
        { slug: 'casse', domaine: 'X' },
      ],
      preuves: [
        { capacite: 'vert', sort: 'vert' },
        { capacite: 'casse', sort: 'rouge' },
      ],
    });
    expect(r.map((c) => c.slug)).toEqual(['vert', 'casse']);
  });
});

describe('croiserPreuves — l’exécution l’emporte sur la déclaration', () => {
  // La liste est PLATE : parcours et suites unitaires y arrivent sous la même
  // forme, et c'est ce qui garantit qu'une capacité ne peut pas ignorer une
  // source de preuves que la mémoire, elle, compterait.
  const JOUES = [
    {
      fichier: 'apps/web/tests/e2e/smoke.spec.ts',
      titre: 'ouvre le tableau de bord',
      titreComplet: `nav ${E}:installer-et-demarrer ouvre le tableau de bord`,
      sort: 'vert',
    },
    {
      fichier: 'apps/web/tests/e2e/smoke.spec.ts',
      titre: 'liste les sections',
      titreComplet: `nav ${E}:installer-et-demarrer liste les sections`,
      sort: 'rouge',
    },
  ];

  it('lit l’étiquette posée sur le DESCRIBE, héritée par chaque cas', () => {
    // C'est la façon la moins verbeuse d'étiqueter : une ligne pour tout un
    // bloc. Ne lire que le titre du cas obligerait à répéter l'étiquette
    // partout, et personne ne le ferait.
    const p = croiserPreuves({ declarees: [], joues: JOUES });
    expect(p).toHaveLength(2);
    expect(p.every((x) => x.capacite === 'installer-et-demarrer')).toBe(true);
    expect(p.map((x) => x.sort)).toEqual(['vert', 'rouge']);
  });

  it('un cas par preuve — pas un fichier', () => {
    // Quand une capacité tombe, la seule information utile est QUEL test exact
    // l'a lâchée. Agréger par fichier la perdrait.
    const p = croiserPreuves({ declarees: [], joues: JOUES });
    expect(p.map((x) => x.titre)).toEqual(['ouvre le tableau de bord', 'liste les sections']);
  });

  it('la déclaration DISPARAÎT quand le même fichier a tourné', () => {
    // Sinon la même preuve compterait deux fois, dont une sans résultat : la
    // capacité s'afficherait « non jouée » à côté d'elle-même.
    const p = croiserPreuves({
      declarees: [
        { capacite: 'installer-et-demarrer', origine: 'apps/web/tests/e2e/smoke.spec.ts' },
      ],
      joues: JOUES,
    });
    expect(p).toHaveLength(2);
    expect(p.every((x) => x.sort)).toBe(true);
  });

  it('une déclaration que rien n’a jouée SURVIT — c’est une preuve qui dort', () => {
    const p = croiserPreuves({
      declarees: [{ capacite: 'approuver-une-action', origine: 'packages/tools/x.test.ts' }],
      joues: JOUES,
    });
    expect(p).toHaveLength(3);
    expect(etatDuneCapacite(p.filter((x) => x.capacite === 'approuver-une-action'))).toBe(
      'non jouée',
    );
  });

  it('un test UNITAIRE joué prouve sa capacité, et son échec la casse', () => {
    // Revue Codex du 11/09, P2. Seuls les résultats Playwright entraient ici,
    // alors que la mesure nocturne collecte aussi les rapports Vitest. Les
    // capacités tenues UNIQUEMENT par de l'unitaire — choisir un modèle,
    // attacher une skill, voir le coût — seraient restées « non jouée » à
    // jamais, et une preuve unitaire rouge n'aurait jamais rougi sa capacité.
    const p = croiserPreuves({
      declarees: [{ capacite: 'choisir-modele', origine: 'packages/llm/src/tests/client.test.ts' }],
      joues: [
        {
          fichier: 'packages/llm/src/tests/client.test.ts',
          titre: `createLlmClient ${E}:choisir-modele résout le fournisseur`,
          sort: 'rouge',
        },
      ],
    });
    expect(etatDuneCapacite(p.filter((x) => x.capacite === 'choisir-modele'))).toBe('rouge');
  });

  it('un parcours joué SANS étiquette ne prouve rien', () => {
    const p = croiserPreuves({
      declarees: [],
      e2e: [
        { fichier: 'x.spec.ts', resultat: { cas: [{ titre: 'sans étiquette', sort: 'vert' }] } },
      ],
    });
    expect(p).toEqual([]);
  });

  it('sans argument, elle ne s’effondre pas', () => {
    expect(croiserPreuves()).toEqual([]);
    expect(croiserPreuves({})).toEqual([]);
  });
});

describe('revendicationsDuDepot — ce que la porte lit dans le dépôt', () => {
  const FICHIERS = [
    'apps/web/tests/e2e/smoke.spec.ts',
    'packages/tools/src/tests/execute.test.ts',
    'packages/tools/src/execute.ts',
    'README.md',
  ];
  const CONTENU = {
    'apps/web/tests/e2e/smoke.spec.ts': `describe('nav ${E}:installer-et-demarrer')`,
    'packages/tools/src/tests/execute.test.ts': `describe('a ${E}:approuver-une-action'); it('b ${E}:approuver-une-action')`,
    // Le code de production PARLE des capacités sans rien prouver : un
    // commentaire, une constante. Le compter reviendrait à laisser un fichier
    // se déclarer sa propre preuve.
    'packages/tools/src/execute.ts': `// voir ${E}:approuver-une-action`,
    'README.md': `Le produit sait ${E}:tout-faire`,
  };
  const lire = (f) => CONTENU[f];

  it('ne lit QUE les fichiers de test', () => {
    const p = revendicationsDuDepot(FICHIERS, lire);
    expect(p.map((x) => x.origine)).toEqual([
      'apps/web/tests/e2e/smoke.spec.ts',
      'packages/tools/src/tests/execute.test.ts',
    ]);
    expect(p.some((x) => x.capacite === 'tout-faire')).toBe(false);
  });

  it('ne compte qu’une fois une capacité revendiquée deux fois dans le même fichier', () => {
    // Sinon un fichier à trente cas ferait croire à trente preuves, et le
    // portail confondrait le volume avec la couverture.
    const p = revendicationsDuDepot(['packages/tools/src/tests/execute.test.ts'], lire);
    expect(p).toEqual([
      { capacite: 'approuver-une-action', origine: 'packages/tools/src/tests/execute.test.ts' },
    ]);
  });

  it('un fichier illisible est ignoré, il ne fait pas tomber la porte', () => {
    // `git ls-files` liste ce que le dépôt suit, pas ce que la branche courante
    // contient : un fichier venu d'ailleurs est absent du disque.
    const p = revendicationsDuDepot(['a.test.ts', 'apps/web/tests/e2e/smoke.spec.ts'], (f) => {
      if (f === 'a.test.ts') throw new Error('ENOENT');
      return CONTENU[f];
    });
    expect(p).toHaveLength(1);
  });
});

describe('le registre lui-même', () => {
  it('n’a aucun slug en double', () => {
    const slugs = CAPACITES.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('n’a que des slugs étiquetables — c’est le contrat avec les titres', () => {
    // Un slug accentué ou en majuscules serait ignoré par `capacitesDunTitre` :
    // la capacité resterait « jamais prouvée » pour toujours, en silence, alors
    // qu'un test la revendique.
    for (const c of CAPACITES) {
      expect(capacitesDunTitre(`@cap:${c.slug}`), c.slug).toEqual([c.slug]);
    }
  });

  it('dit pour chaque capacité ce que l’utilisateur se demande', () => {
    // Le registre existe pour remplacer « web à 78 % » par une phrase qu'un
    // humain reconnaît. Une capacité sans sa question retombe dans le jargon.
    for (const c of CAPACITES) {
      expect(c.nom, c.slug).toBeTruthy();
      expect(c.domaine, c.slug).toBeTruthy();
      expect(c.question, c.slug).toMatch(/\?$/);
    }
  });
});
