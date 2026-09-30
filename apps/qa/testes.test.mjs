// testes.test.mjs — « What is tested » : la règle qui range chaque test dans
// une partie du produit, les cinq derniers tours, et le rendu d'une partie.
//
// Quentin, 30/09/2026 : « on a soi-disant 11 000 tests, je ne les vois pas ».
// Ces preuves portent sur des résultats réels : la partie rendue pour un vrai
// chemin du dépôt, le HTML produit par la fonction que la page exécute, et la
// règle appliquée à TOUS les fichiers de test que git suit aujourd'hui.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import {
  DOMAINES,
  DOMAINE_ARCHITECTURE,
  DOMAINE_NON_RANGE,
  ORDRE_DE_LECTURE,
  domaineDuTest,
  domainesDesFichiers,
  modulesImportes,
  motsDuCode,
  derniersTours,
  etatDesDerniersTours,
  htmlRuban,
  TOURS_MONTRES,
  niveauDuTest,
  testsParDomaine,
  chargeDesTests,
  htmlDuneCharge,
  trouvesDansCharge,
  SCRIPT_TESTES,
  fusionnerTableauGitHub,
} from './lib.mjs';

const partie = (f, texte = '', paquets = []) => domaineDuTest(f, texte, paquets).domaine;

describe('motsDuCode : les mots d’un nom de code', () => {
  it('coupe le camelCase, les tirets et les points, au singulier', () => {
    expect(motsDuCode('ApprovalRequestCard')).toEqual(['approval', 'request', 'card']);
    expect(motsDuCode('approval-rules_fresh.pg')).toEqual(['approval', 'rule', 'fresh', 'pg']);
    expect(motsDuCode('memories')).toEqual(['memory']);
    // « process » n'est pas un pluriel : il ne perd pas son s.
    expect(motsDuCode('process-paths')).toEqual(['process', 'path']);
  });
});

describe('domaineDuTest : la règle, sur de vrais chemins du dépôt', () => {
  it('range par le NOM du fichier, quel que soit le paquet', () => {
    expect(partie('apps/web/src/lib/__tests__/approval-rule-scope.test.ts')).toBe('approvals');
    expect(partie('apps/runner/src/tests/job/delegation-subtree.test.ts')).toBe('delegation');
    expect(partie('packages/tools/src/tests/save-memory.test.ts')).toBe('memory');
    expect(partie('apps/web/tests/e2e/telegram-allowlist.spec.ts')).toBe('channels');
    expect(partie('packages/shared/src/tests/verification-manifest.test.ts')).toBe('proof');
  });

  it('un nom qui ne dit rien est rangé par son DOSSIER, le plus proche d’abord', () => {
    const r = domaineDuTest('apps/runner/src/tests/telegram/handler.test.ts', '');
    expect(r).toEqual({ domaine: 'channels', raison: '"telegram" in the folder telegram' });
    expect(partie('apps/runner/src/tests/job/state.test.ts')).toBe('runs');
    expect(partie('apps/runner/src/tests/channels/slack/manager.test.ts')).toBe('channels');
  });

  it('un paquet à sujet unique range tous ses tests, quel que soit leur nom', () => {
    // `messages` évoquerait le chat : l'adaptateur Gmail parle de Gmail.
    expect(domaineDuTest('packages/adapters/gmail/src/tests/tools/messages.test.ts', '')).toEqual({
      domaine: 'connectors',
      raison: 'lives in packages/adapters',
    });
    expect(partie('packages/db/src/tests/telegram-allowed-queries.test.ts')).toBe('database');
    expect(partie('packages/llm/src/tests/retry.test.ts')).toBe('llm');
    expect(partie('apps/cli/src/tests/ports.test.ts')).toBe('install');
  });

  it('les scanners d’architecture sont rangés à part, dans TOUS les paquets', () => {
    for (const f of [
      'packages/db/src/tests/architecture.test.ts',
      'packages/adapters/notion/src/tests/architecture.test.ts',
      'apps/web/src/tests/one-switch.arch.test.ts',
      'apps/web/src/tests/table-cells.lint.test.ts',
    ]) {
      expect(partie(f), f).toBe(DOMAINE_ARCHITECTURE.id);
    }
  });

  it('le mot le plus PRÉCIS gagne, puis l’ordre de la table', () => {
    // « page shell » (deux mots, un composant) passe devant « shell » (la garde).
    expect(partie('apps/web/src/components/ui/__tests__/PageShellBox.test.tsx')).toBe('screens');
    expect(
      partie(
        'apps/web/src/app/(dashboard)/agents/[id]/edit/__tests__/ShellChecklistSection.test.tsx',
      ),
    ).toBe('approvals');
    // À précision égale, la partie la plus spécifique : la garde du shell avant le moteur de runs.
    expect(partie('apps/runner/src/tests/job/run-command-flow.test.ts')).toBe('approvals');
    expect(partie('apps/runner/src/tests/job-with-mcp-server.test.ts')).toBe('connectors');
  });

  it('en dernier recours, les IMPORTS : un paquet à sujet unique, puis le nom d’un module', () => {
    const paquets = [
      { nom: '@nodal-agents/delivery', chemin: 'packages/delivery' },
      { nom: '@nodal-agents/db', chemin: 'packages/db' },
    ];
    const f = 'packages/tools/src/communication/__tests__/send-media.test.ts';
    expect(domaineDuTest(f, "import { x } from '@nodal-agents/delivery';\n", paquets)).toEqual({
      domaine: 'channels',
      raison: 'imports packages/delivery',
    });
    // La base est importée par presque tout : elle ne désigne pas le sujet.
    expect(partie(f, "import { db } from '@nodal-agents/db';\n", paquets)).toBe('non-range');
    // Un module relatif dont le nom porte le mot.
    expect(
      domaineDuTest(
        'packages/tools/src/tests/preflight-order.test.ts',
        "import { run } from '../execute.js';\n",
      ),
    ).toEqual({ domaine: 'runs', raison: 'imports execute ("execute")' });
  });

  it('ce qu’elle ne sait pas ranger va dans Unclassified, AVEC sa raison — jamais dans une partie par défaut', () => {
    const r = domaineDuTest(
      'packages/shared/src/tests/round-trip.test.ts',
      "import { x } from 'vitest';\n",
    );
    expect(r.domaine).toBe(DOMAINE_NON_RANGE.id);
    expect(r.raison).toMatch(/names an area/);
  });

  it('un fichier disparu est rangé sur son chemin seul, et la raison le dit quand ça ne suffit pas', () => {
    expect(partie('apps/runner/src/tests/lib/workspace-list.test.ts', null)).toBe('workspace');
    const r = domaineDuTest('apps/web/tests/e2e/agent-flows.spec.ts', null);
    expect(r.domaine).toBe('non-range');
    expect(r.raison).toMatch(/no longer in the repository/);
  });

  it('domainesDesFichiers marque le fichier absent, et ne le devine pas', () => {
    const carte = domainesDesFichiers(
      ['apps/runner/src/tests/telegram/poller.test.ts', 'gone/x.test.ts', 'gone/x.test.ts'],
      (f) => (f.startsWith('gone/') ? null : ''),
    );
    expect(Object.keys(carte)).toEqual([
      'apps/runner/src/tests/telegram/poller.test.ts',
      'gone/x.test.ts',
    ]);
    expect(carte['gone/x.test.ts'].absent).toBe(true);
    expect(carte['apps/runner/src/tests/telegram/poller.test.ts']).toMatchObject({
      domaine: 'channels',
      absent: false,
    });
  });
});

describe('modulesImportes', () => {
  it('résout les imports relatifs, l’alias web et les paquets du workspace connus', () => {
    const texte = [
      "import { a } from '../job/state.js';",
      "import { b } from '@/lib/actions';",
      "import { c } from '@nodal-agents/llm/testing';",
      "import { d } from 'vitest';",
      "vi.mock('../../channels/telegram/manager');",
    ].join('\n');
    expect(
      modulesImportes('apps/web/src/tests/x/y.test.ts', texte, [
        { nom: '@nodal-agents/llm', chemin: 'packages/llm' },
      ]),
    ).toEqual([
      'apps/web/src/tests/job/state',
      'apps/web/src/lib/actions',
      'packages/llm/',
      'apps/web/src/channels/telegram/manager',
    ]);
  });
});

describe('la règle, appliquée à TOUS les fichiers de test que git suit', () => {
  const racine = join(
    new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    '..',
    '..',
  );
  const fichiers = execSync('git ls-files', { cwd: racine, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.(test|spec)\.(ts|tsx|mts|mjs)$/.test(f));
  const ids = new Set([
    ...DOMAINES.map((d) => d.id),
    DOMAINE_ARCHITECTURE.id,
    DOMAINE_NON_RANGE.id,
  ]);
  const carte = domainesDesFichiers(fichiers, (f) =>
    existsSync(join(racine, f)) ? readFileSync(join(racine, f), 'utf8') : null,
  );

  it('chaque fichier tombe dans exactement UNE partie connue, avec une raison', () => {
    expect(fichiers.length).toBeGreaterThan(500);
    for (const f of fichiers) {
      expect(ids.has(carte[f].domaine), f).toBe(true);
      expect(carte[f].raison.length, f).toBeGreaterThan(5);
    }
  });

  it('chaque partie de la table reçoit au moins un fichier — aucune partie imaginée', () => {
    const vues = new Set(Object.values(carte).map((r) => r.domaine));
    for (const d of DOMAINES) expect(vues.has(d.id), d.id).toBe(true);
  });

  it('l’ordre de lecture présente chaque partie, et seulement elles', () => {
    expect([...ORDRE_DE_LECTURE].sort()).toEqual([...ids].sort());
  });
});

describe('les cinq derniers tours', () => {
  it('le ruban ne montre QUE les cinq derniers, même sur une fenêtre de trente-trois', () => {
    const recents = 'v'.repeat(28) + 'rvfvi';
    const html = htmlRuban(recents);
    expect(html.match(/class="grain /g)).toHaveLength(TOURS_MONTRES);
    // Du plus ancien au plus récent : rouge, vert, second essai, vert, sauté.
    expect([...html.matchAll(/grain--(\w+)/g)].map((m) => m[1])).toEqual([
      'ko',
      'ok',
      'moyen',
      'ok',
      'inconnu',
    ]);
    expect(html).toContain(
      'last 5 runs, oldest first: failed, passed, passed on retry, passed, skipped',
    );
  });

  it('un test jamais joué le dit, sans carré', () => {
    expect(htmlRuban('')).toContain('never run');
    expect(htmlRuban('vv').match(/class="grain /g)).toHaveLength(2);
  });

  it('dit rouge, instable, sauté ou vert sur les cinq derniers seulement', () => {
    expect(derniersTours('rrrrrvvvvv')).toBe('vvvvv');
    expect(etatDesDerniersTours('rrrrrvvvvv')).toBe('vert');
    expect(etatDesDerniersTours('vvvvr')).toBe('rouge');
    expect(etatDesDerniersTours('vrvvv')).toBe('instable');
    expect(etatDesDerniersTours('vvfvv')).toBe('instable');
    expect(etatDesDerniersTours('iiiii')).toBe('ignore');
    expect(etatDesDerniersTours('')).toBe('jamais');
  });

  // Revue Codex de #633 : « vert » voulait dire « aucun échec », et un test
  // sauté sur un seul de ses cinq tours passait pour vert. Vert veut dire que
  // CHAQUE tour montré a passé.
  it('un seul tour sauté parmi les cinq suffit à ne plus dire vert', () => {
    expect(etatDesDerniersTours('vvvvi')).toBe('ignore');
    expect(etatDesDerniersTours('iivvv')).toBe('ignore');
    expect(etatDesDerniersTours('viiii')).toBe('ignore');
    expect(etatDesDerniersTours('vv')).toBe('vert');
  });

  it('le niveau d’un test se lit sur son chemin', () => {
    expect(niveauDuTest('apps/web/tests/e2e/chat-stop.spec.ts')).toBe('e2e');
    expect(niveauDuTest('apps/web/src/lib/__tests__/chat-list.test.ts')).toBe('ecran');
    expect(niveauDuTest('apps/runner/src/tests/chat/chat-stop.test.ts')).toBe('moteur');
  });
});

describe('testsParDomaine : les comptes d’une partie', () => {
  const LE = '2026-09-29T10:00:00.000Z';
  const t = (fichier, titre, recents, o = {}) => ({
    cle: `${fichier}::${titre}`,
    fichier,
    titre,
    recents,
    tours: recents.length,
    echecs: [...recents].filter((c) => c === 'r').length,
    dernierTourLe: LE,
    ...o,
  });
  const TESTS = [
    t('apps/web/tests/e2e/telegram-allowlist.spec.ts', 'allowlist journey', 'vvvvv'),
    t('apps/runner/src/tests/telegram/handler.test.ts', 'handler red', 'vvvvr', {
      dernierRougeExecution: 'https://x/runs/1',
    }),
    t('apps/runner/src/tests/telegram/handler.test.ts', 'handler flaky', 'vrvvv'),
    t('apps/runner/src/tests/telegram/handler.test.ts', 'handler old', 'vv', {
      dernierTourLe: '2026-09-01T00:00:00.000Z',
    }),
    t('apps/web/src/lib/__tests__/unknown.test.ts', 'a file the map does not know', 'v'),
  ];
  const RANGEMENT = {
    'apps/web/tests/e2e/telegram-allowlist.spec.ts': {
      domaine: 'channels',
      raison: 'r1',
      absent: false,
    },
    'apps/runner/src/tests/telegram/handler.test.ts': {
      domaine: 'channels',
      raison: 'r2',
      absent: true,
    },
  };
  const r = testsParDomaine({ tests: TESTS, rangement: RANGEMENT, mesureLe: LE });
  const canaux = r.parties.find((p) => p.id === 'channels');

  it('compte les tests, l’écran et le moteur, les rouges et les instables sur cinq tours', () => {
    expect(canaux).toMatchObject({
      total: 4,
      ecran: 1,
      e2e: 1,
      moteur: 3,
      rouges: 1,
      instables: 1,
      nonJoues: 1,
      dernierTourLe: LE,
    });
    expect(r).toMatchObject({
      total: 5,
      joues: 4,
      nonJoues: 1,
      rouges: 1,
      instables: 1,
      disparus: 3,
    });
  });

  it('un fichier inconnu de la carte va dans Unclassified, avec la raison — jamais ailleurs', () => {
    const nr = r.parties.find((p) => p.id === 'non-range');
    expect(nr.total).toBe(1);
    expect(nr.fichiers[0].raison).toMatch(/did not know this file/);
    expect(r.parties.at(-1).id).toBe('non-range');
  });

  it('le lien du run n’est posé que sur un test qui a un rouge à montrer', () => {
    const tests = canaux.fichiers.find((f) => f.fichier.includes('handler')).tests;
    expect(tests.find((x) => x.titre === 'handler red').lien).toBe('https://x/runs/1');
    expect(tests.find((x) => x.titre === 'handler flaky').lien).toBeNull();
  });

  it('la charge embarquée porte chaque test, en tableaux courts', () => {
    const c = chargeDesTests(r.parties);
    const lignes = c.flatMap((p) => p.fichiers.flatMap((f) => f[3]));
    expect(lignes).toHaveLength(TESTS.length);
    expect(c.find((p) => p.id === 'channels').fichiers[0]).toEqual([
      'apps/runner/src/tests/telegram/handler.test.ts',
      'r2',
      1,
      [
        ['handler red', 'vvvvr', 1, 5, 1, 'https://x/runs/1'],
        ['handler flaky', 'vrvvv', 1, 5, 1, null],
        ['handler old', 'vv', 0, 2, 0, null],
      ],
    ]);
  });
});

// Revue Codex de #633 : « Install, start & update » portait onze tests `iiiii`
// et affichait « all green on their last 5 runs ». Aucun échec n'est pas tous
// passés : une partie n'est toute verte que si chacun de ses tests a passé à
// chacun des tours montrés.
describe('testsParDomaine : « tout vert » veut dire tous passés, pas aucun échec', () => {
  const LE = '2026-09-29T10:00:00.000Z';
  const t = (fichier, titre, recents) => ({
    cle: `${fichier}::${titre}`,
    fichier,
    titre,
    recents,
    tours: recents.length,
    echecs: 0,
    dernierTourLe: LE,
  });
  const range = (domaine) => ({ domaine, raison: 'r', absent: false });
  const r = testsParDomaine({
    tests: [
      t('install/a.test.ts', 'skipped', 'iiiii'),
      t('install/a.test.ts', 'skipped too', 'iiiii'),
      t('install/a.test.ts', 'passed', 'vvvvv'),
      t('memory/b.test.ts', 'passed', 'vvvvv'),
      t('memory/b.test.ts', 'passed, fewer runs', 'vv'),
      t('chat/c.test.ts', 'passed', 'vvvvv'),
      t('chat/c.test.ts', 'last run skipped', 'vvvvi'),
      t('runs/d.test.ts', 'never run', ''),
    ],
    rangement: {
      'install/a.test.ts': range('install'),
      'memory/b.test.ts': range('memory'),
      'chat/c.test.ts': range('chat'),
      'runs/d.test.ts': range('runs'),
    },
    mesureLe: LE,
  });
  const partie = (id) => r.parties.find((p) => p.id === id);

  it('des tests sautés et aucun rouge : PAS tout vert, et les sautés sont comptés', () => {
    expect(partie('install')).toMatchObject({
      rouges: 0,
      instables: 0,
      ignores: 2,
      jamais: 0,
      toutVert: false,
    });
  });

  it('un seul tour sauté sur un seul test suffit', () => {
    expect(partie('chat')).toMatchObject({ rouges: 0, instables: 0, ignores: 1, toutVert: false });
  });

  it('un test jamais joué n’est pas vert non plus', () => {
    expect(partie('runs')).toMatchObject({ ignores: 0, jamais: 1, toutVert: false });
  });

  it('tous les tests passés à chaque tour montré : tout vert', () => {
    expect(partie('memory')).toMatchObject({ ignores: 0, jamais: 0, toutVert: true });
  });
});

describe('htmlDuneCharge : ce que la page dessine à l’ouverture d’une partie', () => {
  const CHARGE = {
    id: 'channels',
    fichiers: [
      [
        'apps/runner/src/tests/telegram/handler.test.ts',
        '"telegram" in the folder telegram',
        0,
        [
          ['handler <b>escapes</b>', 'v'.repeat(5), 0, 30, 1, null],
          ['handler red', 'vvvvr', 3, 30, 1, 'https://x/runs/9'],
          ['handler not run', 'vv', 0, 2, 0, null],
        ],
      ],
      ['apps/web/tests/e2e/slack.spec.ts', 'r', 1, [['slack journey', 'v', 0, 1, 1, null]]],
    ],
  };

  it('rend chaque fichier, sa raison, et chaque test avec son ruban de cinq', () => {
    const { html, trouves } = htmlDuneCharge(CHARGE, '', 0);
    expect(trouves).toBe(4);
    expect(html).toContain('why here: &quot;telegram&quot; in the folder telegram');
    expect(html).toContain('handler &lt;b&gt;escapes&lt;/b&gt;');
    expect(html).not.toContain('<b>escapes</b>');
    expect(html).toContain('3/30');
    expect(html).toContain('href="https://x/runs/9"');
    expect(html).toContain('not run at the last measurement');
    expect(html).toContain('file no longer in the repository');
    expect(html).toContain('1 red or flaky');
    // Fermés sans recherche.
    expect(html).not.toContain('<details class="fichier-tests" open');
  });

  it('filtre par titre OU par chemin, ouvre ce qui répond, et le compte comme trouvesDansCharge', () => {
    const parTitre = htmlDuneCharge(CHARGE, 'RED', 0);
    expect(parTitre.trouves).toBe(1);
    expect(parTitre.html).toContain('handler red');
    expect(parTitre.html).not.toContain('slack journey');
    expect(parTitre.html).toContain('<details class="fichier-tests" open');
    expect(trouvesDansCharge(CHARGE, 'RED')).toBe(1);
    expect(htmlDuneCharge(CHARGE, 'slack.spec', 0).trouves).toBe(1);
    expect(trouvesDansCharge(CHARGE, 'telegram/')).toBe(3);
    expect(htmlDuneCharge(CHARGE, 'nothing like this', 0).html).toContain('No test here matches');
  });

  it('au-delà du plafond, DIT combien de résultats ne sont pas dessinés', () => {
    const { html, trouves } = htmlDuneCharge(CHARGE, 'handler', 2);
    expect(trouves).toBe(3);
    expect((html.match(/<tr><td>/g) ?? []).length).toBe(2);
    expect(html).toContain('1 more match in this area is not drawn');
  });

  it('la page exécute EXACTEMENT ces fonctions : le script les inscrit, et les rejoue pareil', () => {
    for (const fn of [htmlRuban, htmlDuneCharge, trouvesDansCharge]) {
      expect(SCRIPT_TESTES, fn.name).toContain(String(fn));
    }
    expect(SCRIPT_TESTES).not.toContain('</scr' + 'ipt');
    const joue = new Function(
      'charge',
      `${SCRIPT_TESTES}\nreturn htmlDuneCharge(charge, 'red', 0);`,
    );
    expect(joue(CHARGE)).toEqual(htmlDuneCharge(CHARGE, 'red', 0));
  });
});

describe('le rangement survit au rafraîchissement du déploiement', () => {
  const MESURE = { genereLe: 'm', rangement: { le: 'ancien', fichiers: { a: 1 } } };
  it('le rangement relu remplace celui de la mesure', () => {
    const r = fusionnerTableauGitHub(MESURE, { rangement: { le: 'frais', fichiers: { b: 1 } } });
    expect(r.rangement.le).toBe('frais');
  });
  it('un rafraîchissement qui n’a rien rangé garde celui de la mesure, daté comme tel', () => {
    expect(fusionnerTableauGitHub(MESURE, { rangement: null }).rangement.le).toBe('ancien');
  });
});
