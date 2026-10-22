// workflows/suites/code.ts — du code qui doit MARCHER, jugé sur ce que l'agent a lancé.
//
// Chaque scénario pose un petit projet Node (packages/bench/fixtures/code)
// dans le dossier du banc de l'espace partagé, avec une suite de tests qui
// échoue. Le juge exige que CHAQUE test de la fixture soit passé par son nom
// dans le dernier lancement de tests de l'agent, et que les fichiers de test
// soient ceux de la fixture, octet pour octet (supprimer un test ne le fait
// pas passer).
//
// Le banc n'exécute JAMAIS le code écrit par un agent hors bac à sable (revue
// Reviewer A de #756, passes 1 et 2). Une règle sur le nom de l'outil et sur
// la commande (« l'agent a lancé `npm test` ») se contourne : un `echo`, un
// `cd` ailleurs, un outil MCP qui s'appelle `bash`. Le juge lit donc la SORTIE
// du dernier outil de commande de l'agent qui porte des résultats de tests
// (lignes TAP ou du rapporteur spec de `node --test`) ; ce que le banc ne
// vérifie pas par lui-même est dit sur chaque ligne (`TESTS_NOT_RERUN`). Le
// jour où un bac à sable de la plateforme sera disponible (#753), relancer la
// suite à l'intérieur rétablira le contrôle.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findInRoots, readText } from '../disk';
import type { TreeFacts } from '../facts';
import { fileHash, fixturePath, sharedRoot } from '../fixtures';
import {
  COMMAND_TOOL,
  JUDGED_COMMON,
  SCRIPT_RUNNER,
  answerOf,
  bareToolName,
  commandRuns,
  commonReasons,
  parseJson,
  textHasNumber,
} from '../judge-kit';
import { defineScenario, type AnyScenario, type UnverifiedCheck } from '../types';
import { BASE, COMMANDS, FILES, TEAM, toolList } from '../scenario-tools';

const MIN = 60_000;

/** Ce que le banc ne vérifie pas lui-même : il ne relance pas la suite (il n'exécute aucun code d'agent). */
export const TESTS_NOT_RERUN: UnverifiedCheck = {
  check: 'tests re-run by the bench',
  state: 'not verified',
  reason:
    "The bench never executes agent-written code outside a sandbox: the verdict reads the agent's own last test run, whose output a tool could fake.",
  ticket: '#753',
};

/** Les tests passés et échoués qu'un texte rapporte : TAP (`ok N - nom`) ou rapporteur spec (`✔ nom`). */
export function testResultsIn(text: string): { passed: string[]; failed: string[] } | null {
  const names = (re: RegExp): string[] =>
    [...text.matchAll(re)].map((m) => m[1]!.replace(/\s+\([\d.]+m?s\)$/, '').trim());
  const passed = [...names(/^\s*ok \d+ - (.+?)(?: # .*)?$/gm), ...names(/^\s*✔ (.+)$/gm)];
  const failed = [...names(/^\s*not ok \d+ - (.+?)(?: # .*)?$/gm), ...names(/^\s*✖ (.+)$/gm)];
  return passed.length + failed.length === 0 ? null : { passed, failed };
}

/** Le texte qu'un outil de commande a rendu : stdout et stderr quand la sortie est du JSON, sinon le texte brut. */
function commandText(output: string | null): string {
  if (output === null) return '';
  const o = parseJson(output) as { stdout?: unknown; stderr?: unknown } | null;
  if (o && typeof o === 'object' && (typeof o.stdout === 'string' || typeof o.stderr === 'string'))
    return `${typeof o.stdout === 'string' ? o.stdout : ''}\n${typeof o.stderr === 'string' ? o.stderr : ''}`;
  return output;
}

/**
 * Le DERNIER lancement des tests DE CE PROJET par l'agent : la sortie du
 * dernier outil de commande qui rapporte TOUS les tests attendus (passés ou
 * échoués). Un `✔ done` d'une étape de lint, un `cat`, une suite d'un autre
 * dossier ou un lancement partiel ne le remplacent pas (revue Reviewer A,
 * passe 3) ; sans lancement complet, null : jamais une correspondance partielle.
 */
export function lastAgentTestRun(
  facts: TreeFacts,
  expected: readonly string[],
): { passed: string[]; failed: string[] } | null {
  const runs = facts.toolCalls
    .filter((c) => COMMAND_TOOL.test(bareToolName(c.toolName)))
    .map((c) => testResultsIn(commandText(c.output)))
    .filter(
      (x): x is { passed: string[]; failed: string[] } =>
        x !== null && expected.every((t) => x.passed.includes(t) || x.failed.includes(t)),
    );
  return runs[runs.length - 1] ?? null;
}

/** Les noms des tests qu'un fichier de test déclare (`test('…'`). */
export function declaredTests(source: string): string[] {
  return [...source.matchAll(/\btest\(\s*(['"`])((?:(?!\1)[^\\]|\\.)*)\1/g)].map((m) =>
    m[2]!.replace(/\\(['"`])/g, '$1'),
  );
}

interface ProjectObservation {
  readonly exists: boolean;
  /** Fichier de test (relatif au projet) → empreinte actuelle, null s'il a disparu. */
  readonly testHashes: Record<string, string | null>;
  readonly sourceHash: string | null;
  readonly extra: Record<string, unknown>;
}

function testFiles(project: string): string[] {
  return readdirSync(join(fixturePath(`code/${project}`), 'test'));
}

/** Ce qu'on lit du projet sur le disque. Rien n'y est exécuté. */
function observeProject(
  root: string,
  project: string,
  source: string,
  extra: (dir: string) => Record<string, unknown> = () => ({}),
): ProjectObservation {
  const dir = join(root, 'nodal-bench', project);
  if (!existsSync(dir)) return { exists: false, testHashes: {}, sourceHash: null, extra: {} };
  const testHashes: Record<string, string | null> = {};
  for (const f of testFiles(project)) {
    const p = join(dir, 'test', f);
    testHashes[f] = existsSync(p) ? fileHash(p) : null;
  }
  const src = join(dir, source);
  return {
    exists: true,
    testHashes,
    sourceHash: existsSync(src) ? fileHash(src) : null,
    extra: extra(dir),
  };
}

/** Les raisons communes : projet présent, tests intacts, chaque test de la fixture passé dans le dernier lancement de l'agent. */
function judgeProject(facts: TreeFacts, project: string, o: ProjectObservation): string[] {
  const r = commonReasons(facts);
  if (!o.exists) return [...r, `the project nodal-bench/${project} is gone`];
  for (const f of testFiles(project)) {
    const want = fileHash(join(fixturePath(`code/${project}`), 'test', f));
    if (o.testHashes[f] === null) r.push(`the test file test/${f} was deleted`);
    else if (o.testHashes[f] !== want) r.push(`the test file test/${f} was changed`);
  }
  const expected = testFiles(project).flatMap((f) =>
    declaredTests(readFileSync(join(fixturePath(`code/${project}`), 'test', f), 'utf8')),
  );
  const run = lastAgentTestRun(facts, expected);
  if (run === null) return [...r, 'no test run of this project found'];
  const notPassed = expected.filter((t) => !run.passed.includes(t) || run.failed.includes(t));
  if (notPassed.length > 0)
    r.push(
      `in the agent's last test run, ${notPassed.length} test(s) do not pass: ${notPassed.join('; ')}`,
    );
  return r;
}

/** Le chemin des projets : le script EST le sujet, aucun outil du produit n'est attendu. */
const PROJECT_PATH =
  'Read, run the tests, fix, run them again. Measured: a command tool or a code CLI (Claude Code, Codex).';

function codeProject(o: {
  id: string;
  /** La liste fermée des outils de l'essai (décision 1B). */
  tools: readonly string[];
  title: string;
  green: string;
  path?: string;
  deliverable: string;
  project: string;
  source: string;
  instruction: string;
  extraJudge?: (o: ProjectObservation) => string[];
  extraObserve?: (dir: string) => Record<string, unknown>;
  /** Ce que `extraJudge` vérifie, en clair. */
  extraJudgedBy?: string[];
}): AnyScenario {
  return defineScenario<ProjectObservation>({
    id: o.id,
    // v2 (1B) : la liste d'outils fermée de l'essai (scenario-tools.ts).
    version: 2,
    tools: o.tools,
    title: o.title,
    green: o.green,
    path: o.path ?? PROJECT_PATH,
    deliverable: o.deliverable,
    set: 'on-demand',
    activity: 'code',
    sends: 'nothing',
    instruction: o.instruction,
    timeoutMs: 20 * MIN,
    unverified: [TESTS_NOT_RERUN],
    judgedBy: [
      ...JUDGED_COMMON,
      `the test files of nodal-bench/${o.project} are byte for byte the fixture's (sha-256)`,
      `tool_calls: the agent's last command output that reports EVERY test of the project (TAP or spec lines); each test must have passed, by name: ${testFiles(
        o.project,
      )
        .flatMap((f) =>
          declaredTests(readFileSync(join(fixturePath(`code/${o.project}`), 'test', f), 'utf8')),
        )
        .join(' · ')}`,
      'the bench never runs the code itself (no sandbox yet, #753)',
      ...(o.extraJudgedBy ?? []),
    ],
    fixtures: [{ from: `code/${o.project}`, to: `nodal-bench/${o.project}` }],
    observe: async (_facts, env) =>
      observeProject(sharedRoot(env.workspaceRoots), o.project, o.source, o.extraObserve),
    judge(facts, ob) {
      const r = judgeProject(facts, o.project, ob);
      if (ob.exists && o.extraJudge) r.push(...o.extraJudge(ob));
      return r;
    },
  });
}

const SHARED = "dans l'espace de travail partagé";

// ─── code : récupérer un fichier et le traiter par script ────────────────────
//
// La fusion de `code` (télécharger un fichier public, lancer un script) et de
// `code-data` (un total par catégorie, écrit en JSON) : la même capacité, un
// seul essai. Le fichier est figé par son commit, son contenu ne peut plus
// changer ; le banc recalcule les totaux sur le fichier RÉELLEMENT téléchargé.

/** Un fichier public figé par son commit : son contenu ne peut plus changer. */
export const CODE_URL =
  'https://raw.githubusercontent.com/mwaskom/seaborn-data/8504c04d4b02ac56527949baafb416e5864698b6/iris.csv';
export const CODE_REL = 'nodal-bench/iris.csv';
export const CODE_JSON_REL = 'nodal-bench/iris-totaux.json';
const CODE_ROWS = 150;
/** Le total de petal_length par espèce de ce fichier : ce qui prouve qu'il est intact. */
export const CODE_TOTALS: Readonly<Record<string, number>> = {
  setosa: 73.1,
  versicolor: 213,
  virginica: 277.6,
};

/** Recalcule les totaux de petal_length par espèce sur un CSV, au centième. */
export function petalTotalsBySpecies(csv: string): {
  rows: number;
  totals: Record<string, number>;
} {
  const lines = csv.replace(/\r\n/g, '\n').trim().split('\n');
  const header = (lines[0] ?? '').split(',').map((h) => h.trim());
  const len = header.indexOf('petal_length');
  const sp = header.indexOf('species');
  const hundredths: Record<string, number> = {};
  for (const l of lines.slice(1)) {
    const f = l.split(',');
    const species = (f[sp] ?? '').trim();
    hundredths[species] = (hundredths[species] ?? 0) + Math.round(Number(f[len]) * 100);
  }
  return {
    rows: lines.length - 1,
    totals: Object.fromEntries(Object.entries(hundredths).map(([k, v]) => [k, v / 100])),
  };
}

interface FetchObservation {
  readonly csv: { fresh: boolean; rows: number; totals: Record<string, number> } | null;
  readonly json: { fresh: boolean; text: string } | null;
}

const sameTotals = (a: Record<string, number>, b: Readonly<Record<string, number>>): boolean =>
  Object.keys(a).length === Object.keys(b).length &&
  Object.entries(b).every(([k, v]) => typeof a[k] === 'number' && Math.abs(a[k]! - v) <= 0.005);

const fetchAndProcess = defineScenario<FetchObservation>({
  // L'identifiant du premier des deux scénarios fusionnés (code, code-data).
  id: 'code',
  // v2 (catalogue du 17/10) : un total par catégorie écrit en JSON et donné
  // dans la réponse, au lieu d'une seule somme imprimée par le script.
  // v3 (1B) : la liste d'outils fermée de l'essai (scenario-tools.ts).
  version: 3,
  tools: toolList(BASE, FILES, TEAM, COMMANDS),
  title: 'Fetch a file and process it with a script',
  green: `The CSV was downloaded into ${CODE_REL} during the run and is the pinned file (${CODE_ROWS} rows, its totals); a Python or Node script ran; ${CODE_JSON_REL} was written during the run with exactly one total per species, equal to what the bench recomputes from the downloaded file (to the hundredth); the answer gives each total; nobody was asked anything.`,
  path: 'A download, then a Python or Node script. Measured: the command tool or code CLI that ran it.',
  deliverable: `${CODE_JSON_REL} and the answer`,
  set: 'nightly',
  activity: 'code',
  sends: 'nothing',
  instruction:
    `Télécharge ${CODE_URL} dans ton espace de travail, sous ${CODE_REL}. Puis écris et exécute un ` +
    'script Python (ou Node) qui calcule le total de la colonne petal_length pour chaque espèce ' +
    `(colonne species), écris le résultat dans ${CODE_JSON_REL} sous la forme ` +
    '{"<espèce>": <total>, …}, et donne-moi les totaux.',
  timeoutMs: 15 * MIN,
  judgedBy: [
    ...JUDGED_COMMON,
    `opens ${CODE_REL}, written during the trial: ${CODE_ROWS} data rows and the totals of the pinned file (${Object.entries(
      CODE_TOTALS,
    )
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')})`,
    'tool_calls: a command tool ran a Python or Node script',
    `opens ${CODE_JSON_REL} (written during the trial) and parses it as JSON: exactly one key per species, each value the total the bench recomputes from the downloaded CSV (± 0.005)`,
    'the final answer gives each total',
  ],
  outputs: [CODE_REL, CODE_JSON_REL],
  async observe(_facts, env) {
    const [csv] = findInRoots(env.workspaceRoots, CODE_REL, env.startedMs);
    const [json] = findInRoots(env.workspaceRoots, CODE_JSON_REL, env.startedMs);
    return {
      csv: csv ? { fresh: csv.fresh, ...petalTotalsBySpecies(readText(csv.path)) } : null,
      json: json ? { fresh: json.fresh, text: readText(json.path) } : null,
    };
  },
  judge(facts, o) {
    const r = commonReasons(facts);
    if (!o.csv) r.push(`the CSV was not downloaded into ${CODE_REL}`);
    else {
      if (!o.csv.fresh) r.push(`${CODE_REL} exists but was not written during the run`);
      if (o.csv.rows !== CODE_ROWS || !sameTotals(o.csv.totals, CODE_TOTALS))
        r.push(
          `the downloaded file is not the pinned one (${o.csv.rows} rows, totals ${JSON.stringify(o.csv.totals)})`,
        );
    }
    if (commandRuns(facts, SCRIPT_RUNNER).length === 0) r.push('no Python or Node script ran');
    const want = o.csv?.totals ?? CODE_TOTALS;
    const answer = answerOf(facts);
    const notGiven = Object.entries(want).filter(([, v]) => !textHasNumber(answer, v, 1));
    if (notGiven.length > 0)
      r.push(`the answer does not give the total of ${notGiven.map(([k]) => k).join(', ')}`);
    if (!o.json) return [...r, `no file ${CODE_JSON_REL}`];
    if (!o.json.fresh) r.push(`${CODE_JSON_REL} was not written during the run`);
    const got = parseJson(o.json.text.replace(/^﻿/, ''));
    if (!got || typeof got !== 'object' || Array.isArray(got))
      return [...r, `${CODE_JSON_REL} is not a JSON object`];
    const g = got as Record<string, unknown>;
    for (const [species, value] of Object.entries(want)) {
      const v = g[species];
      if (typeof v !== 'number')
        r.push(`${species} is ${JSON.stringify(v ?? null)}, expected ${value}`);
      else if (Math.abs(v - value) > 0.005) r.push(`${species} is ${v}, expected ${value}`);
    }
    const extra = Object.keys(g).filter((k) => !(k in want));
    if (extra.length > 0) r.push(`unexpected keys: ${extra.join(', ')}`);
    return r;
  },
});

// ─── les projets ─────────────────────────────────────────────────────────────

export const CODE_SCENARIOS: AnyScenario[] = [
  codeProject({
    id: 'code-bugfix',
    tools: toolList(BASE, FILES, TEAM, COMMANDS),
    title: 'Fix a bug reported by tests',
    deliverable: 'src/facture.js, fixed',
    green:
      "src/facture.js was changed, every test of nodal-bench/facture-tva passes in the agent's last test run, the test files are untouched, and nobody was asked anything; the bench does not re-run the suite (#753).",
    project: 'facture-tva',
    source: 'src/facture.js',
    instruction:
      `Les tests du projet nodal-bench/facture-tva ${SHARED} échouent. Trouve et corrige le ou ` +
      'les bugs dans src/facture.js pour que `npm test` passe, sans modifier les tests.',
    extraJudgedBy: ['src/facture.js differs from the fixture (the bug file was changed)'],
    extraJudge(o) {
      return o.sourceHash === fileHash(join(fixturePath('code/facture-tva'), 'src', 'facture.js'))
        ? ['src/facture.js was not changed']
        : [];
    },
  }),
  codeProject({
    id: 'code-http-server',
    tools: toolList(BASE, FILES, TEAM, COMMANDS),
    title: 'Write code from a tested specification',
    deliverable: 'src/server.js, written',
    green:
      "In the agent's last test run every test of nodal-bench/http-somme passes (the suite starts a local HTTP server), the test files are untouched, and nobody was asked anything; the bench does not re-run the suite (#753).",
    project: 'http-somme',
    source: 'src/server.js',
    instruction:
      `Le projet nodal-bench/http-somme ${SHARED} a une suite de tests qui démarre un serveur HTTP ` +
      'local. Implémente src/server.js pour que `npm test` passe, sans modifier les tests.',
  }),
  codeProject({
    id: 'code-install-dep',
    tools: toolList(BASE, FILES, TEAM, COMMANDS),
    title: 'Install a dependency and use it',
    deliverable: 'package.json, node_modules and src/slug.js',
    green:
      "slugify is declared in package.json and installed in node_modules, src/slug.js imports it, every test of nodal-bench/slug-titre passes in the agent's last test run, the test files are untouched, and nobody was asked anything; the bench does not re-run the suite (#753).",
    project: 'slug-titre',
    source: 'src/slug.js',
    instruction:
      `Dans le projet nodal-bench/slug-titre ${SHARED}, installe le paquet npm slugify, puis ` +
      'utilise-le pour implémenter src/slug.js, jusqu’à ce que `npm test` passe. Ne modifie pas les tests.',
    extraObserve(dir) {
      const pkgPath = join(dir, 'package.json');
      const pkg = parseJson(existsSync(pkgPath) ? readFileSync(pkgPath, 'utf8') : null) as {
        dependencies?: Record<string, string>;
      } | null;
      const installedPkg = join(dir, 'node_modules', 'slugify', 'package.json');
      const src = join(dir, 'src', 'slug.js');
      return {
        declared: typeof pkg?.dependencies?.['slugify'] === 'string',
        installed:
          existsSync(installedPkg) &&
          (parseJson(readFileSync(installedPkg, 'utf8')) as { name?: string } | null)?.name ===
            'slugify',
        imports:
          existsSync(src) &&
          /(from\s+['"]slugify['"]|require\(\s*['"]slugify['"]\s*\)|import\(\s*['"]slugify['"]\s*\))/.test(
            readFileSync(src, 'utf8'),
          ),
      };
    },
    extraJudgedBy: [
      'package.json declares slugify in its dependencies',
      'node_modules/slugify/package.json exists and names slugify',
      'src/slug.js imports slugify (import or require)',
    ],
    extraJudge(o) {
      const r: string[] = [];
      if (o.extra['declared'] !== true)
        r.push('slugify is not in the dependencies of package.json');
      if (o.extra['installed'] !== true) r.push('slugify is not installed in node_modules');
      if (o.extra['imports'] !== true) r.push('src/slug.js does not import slugify');
      return r;
    },
  }),
  fetchAndProcess,
];
