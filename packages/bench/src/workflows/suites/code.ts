// workflows/suites/code.ts — du code qui doit MARCHER, prouvé en le relançant.
//
// Chaque scénario pose un petit projet Node (packages/bench/fixtures/code)
// dans le dossier du banc de l'espace partagé, avec une suite de tests qui
// échoue. Le juge ne croit pas l'agent qui dit « les tests passent » : il
// relance lui-même la suite (`node --test`, sortie TAP), exige que CHAQUE test
// de la fixture soit passé par son nom, et que les fichiers de test soient
// ceux de la fixture, octet pour octet (supprimer un test ne le fait pas
// passer).
//
// Le banc exécute ainsi le code écrit par l'agent, hors bac à sable : il ne le
// fait QUE si l'agent l'a déjà exécuté lui-même (une ligne `tool_calls` qui
// lance la suite), constaté dans la base AVANT toute relance. Le banc ne donne
// jamais l'exécution à un agent qui ne l'avait pas (revue Reviewer A, #756).

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TreeFacts } from '../facts';
import {
  fileHash,
  fixturePath,
  installFixture,
  installed,
  resetBenchPath,
  sharedRoot,
} from '../fixtures';
import { REGIONS } from '../fixture-data';
import { SCRIPT_RUNNER, commandRuns, commonReasons, parseJson } from '../judge-kit';
import { defineScenario, type AnyScenario } from '../types';

const MIN = 60_000;
const TEST_TIMEOUT_MS = 120_000;

export interface TestRun {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** Les tests passés, par leur nom (lignes TAP `ok N - nom`). */
  readonly passed: string[];
  readonly failed: string[];
  /** La fin de la sortie, pour la raison d'un rouge. */
  readonly tail: string;
}

/** Relance `node --test` dans `dir`, avec le Node qui fait tourner le banc. */
export function runNodeTests(dir: string): TestRun {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: TEST_TIMEOUT_MS,
    windowsHide: true,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const names = (re: RegExp): string[] => [...out.matchAll(re)].map((m) => m[1]!.trim());
  return {
    exitCode: r.status,
    timedOut: r.error !== undefined && /ETIMEDOUT/.test(String(r.error)),
    passed: names(/^ok \d+ - (.+?)(?: # .*)?$/gm),
    failed: names(/^not ok \d+ - (.+?)(?: # .*)?$/gm),
    tail: out.trim().split('\n').slice(-6).join(' | '),
  };
}

/** Une commande qui lance la suite de tests d'un projet Node. */
const TEST_RUN = /npm(\.cmd)?\s+(run\s+)?test|node\s+--test|pnpm\s+test/i;

/** L'agent a lancé la suite lui-même : le seul cas où le banc la relance. */
export function agentRanTheSuite(facts: TreeFacts): boolean {
  return commandRuns(facts, TEST_RUN).length > 0;
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
  /** La relance du banc ; null quand l'agent n'a jamais lancé la suite (aucune relance). */
  readonly run: TestRun | null;
  readonly extra: Record<string, unknown>;
}

function testFiles(project: string): string[] {
  return readdirSync(join(fixturePath(`code/${project}`), 'test'));
}

function observeProject(
  facts: TreeFacts,
  root: string,
  project: string,
  source: string,
  extra: (dir: string) => Record<string, unknown> = () => ({}),
): ProjectObservation {
  const dir = join(root, 'nodal-bench', project);
  if (!existsSync(dir))
    return { exists: false, testHashes: {}, sourceHash: null, run: null, extra: {} };
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
    run: agentRanTheSuite(facts) ? runNodeTests(dir) : null,
    extra: extra(dir),
  };
}

/** Les raisons communes : projet présent, tests intacts, chaque test de la fixture passé, la suite lancée par l'agent. */
function judgeProject(facts: TreeFacts, project: string, o: ProjectObservation): string[] {
  const r = commonReasons(facts);
  if (!o.exists) return [...r, `the project nodal-bench/${project} is gone`];
  for (const f of testFiles(project)) {
    const want = fileHash(join(fixturePath(`code/${project}`), 'test', f));
    if (o.testHashes[f] === null) r.push(`the test file test/${f} was deleted`);
    else if (o.testHashes[f] !== want) r.push(`the test file test/${f} was changed`);
  }
  const run = o.run;
  if (!agentRanTheSuite(facts) || run === null) return [...r, 'the agent never ran the test suite'];
  if (run.timedOut) r.push(`the test suite did not finish in ${TEST_TIMEOUT_MS / 1000} s`);
  else {
    const expected = testFiles(project).flatMap((f) =>
      declaredTests(readFileSync(join(fixturePath(`code/${project}`), 'test', f), 'utf8')),
    );
    const notPassed = expected.filter((t) => !run.passed.includes(t));
    if (notPassed.length > 0)
      r.push(
        `rerun by the bench, ${notPassed.length} test(s) do not pass: ${notPassed.join('; ')}`,
      );
    else if (run.exitCode !== 0)
      r.push(`rerun by the bench, the suite exits ${run.exitCode}: ${run.tail}`);
  }
  return r;
}

function codeProject(o: {
  id: string;
  title: string;
  green: string;
  project: string;
  source: string;
  instruction: string;
  extraJudge?: (o: ProjectObservation) => string[];
  extraObserve?: (dir: string) => Record<string, unknown>;
}): AnyScenario {
  return defineScenario<ProjectObservation>({
    id: o.id,
    version: 1,
    title: o.title,
    green: o.green,
    set: 'on-demand',
    activity: 'code',
    instruction: o.instruction,
    timeoutMs: 20 * MIN,
    prepare(env) {
      installFixture(env.workspaceRoots, `code/${o.project}`, `nodal-bench/${o.project}`);
    },
    observe: async (facts, env) =>
      observeProject(facts, sharedRoot(env.workspaceRoots), o.project, o.source, o.extraObserve),
    judge(facts, ob) {
      const r = judgeProject(facts, o.project, ob);
      if (ob.exists && o.extraJudge) r.push(...o.extraJudge(ob));
      return r;
    },
  });
}

const SHARED = "dans l'espace de travail partagé";

// ─── code-data ───────────────────────────────────────────────────────────────

export const DATA_CSV_REL = 'nodal-bench/ventes-regions.csv';
export const DATA_JSON_REL = 'nodal-bench/ca-par-region.json';

/** Le chiffre d'affaires par région, recalculé par le banc sur le CSV, au centime. */
export function revenueByRegion(csv: string): Record<string, number> {
  const [head, ...rows] = csv.replace(/\r\n/g, '\n').trim().split('\n');
  const h = (head ?? '').split(',');
  const [reg, qty, price] = ['region', 'quantite', 'prix_unitaire'].map((k) => h.indexOf(k));
  const cents: Record<string, number> = {};
  for (const line of rows) {
    const f = line.split(',');
    const c = Math.round(Number(f[qty!]) * Math.round(Number(f[price!]) * 100));
    cents[f[reg!]!] = (cents[f[reg!]!] ?? 0) + c;
  }
  return Object.fromEntries(Object.entries(cents).map(([k, v]) => [k, v / 100]));
}

interface DataObservation {
  readonly csvHash: string | null;
  readonly json: { fresh: boolean; text: string } | null;
}

const codeData = defineScenario<DataObservation>({
  id: 'code-data',
  version: 1,
  title: 'A data script: revenue per region from a CSV',
  green: `A Python or Node script ran, ${DATA_JSON_REL} was written during the run and holds, for each of the ${REGIONS.length} regions and nothing else, the revenue the bench recomputes from the untouched CSV (to the cent), and nobody was asked anything.`,
  set: 'on-demand',
  activity: 'code',
  instruction:
    `Le fichier ${DATA_CSV_REL} ${SHARED} contient des ventes (une ligne par vente). Écris et ` +
    'exécute un script Python ou Node qui calcule le chiffre d’affaires (quantité × prix unitaire) ' +
    `total par région, puis écris le résultat dans ${DATA_JSON_REL} sous la forme ` +
    '{"Nord": 1234.56, …}, arrondi au centime.',
  timeoutMs: 15 * MIN,
  prepare(env) {
    installFixture(env.workspaceRoots, 'data/ventes-regions.csv', DATA_CSV_REL);
    resetBenchPath(env.workspaceRoots, DATA_JSON_REL);
  },
  async observe(_facts, env) {
    const csv = installed(env.workspaceRoots, DATA_CSV_REL, env.startedMs);
    const json = installed(env.workspaceRoots, DATA_JSON_REL, env.startedMs);
    return {
      csvHash: csv.exists ? fileHash(csv.path) : null,
      json: json.exists ? { fresh: json.fresh, text: readFileSync(json.path, 'utf8') } : null,
    };
  },
  judge(facts, o) {
    const r = commonReasons(facts);
    const fixture = fixturePath('data/ventes-regions.csv');
    if (o.csvHash !== fileHash(fixture)) r.push(`${DATA_CSV_REL} was changed or removed`);
    if (commandRuns(facts, SCRIPT_RUNNER).length === 0) r.push('no Python or Node script ran');
    if (!o.json) return [...r, `no file ${DATA_JSON_REL}`];
    if (!o.json.fresh) r.push(`${DATA_JSON_REL} was not written during the run`);
    const got = parseJson(o.json.text.replace(/^﻿/, ''));
    if (!got || typeof got !== 'object' || Array.isArray(got))
      return [...r, `${DATA_JSON_REL} is not a JSON object`];
    const want = revenueByRegion(readFileSync(fixture, 'utf8'));
    const g = got as Record<string, unknown>;
    for (const [region, value] of Object.entries(want)) {
      const v = g[region];
      if (typeof v !== 'number')
        r.push(`${region} is ${JSON.stringify(v ?? null)}, expected ${value}`);
      else if (Math.abs(v - value) > 0.005) r.push(`${region} is ${v}, expected ${value}`);
    }
    const extra = Object.keys(g).filter((k) => !(k in want));
    if (extra.length > 0) r.push(`unexpected keys: ${extra.join(', ')}`);
    return r;
  },
});

// ─── les projets ─────────────────────────────────────────────────────────────

export const CODE_SCENARIOS: AnyScenario[] = [
  codeProject({
    id: 'code-http-server',
    title: 'Implement a local HTTP service until its test suite passes',
    green:
      'Rerun by the bench, every test of nodal-bench/http-somme passes (the suite starts a local HTTP server), the test files are untouched, the agent ran the suite itself, and nobody was asked anything.',
    project: 'http-somme',
    source: 'src/server.js',
    instruction:
      `Le projet nodal-bench/http-somme ${SHARED} a une suite de tests qui démarre un serveur HTTP ` +
      'local. Implémente src/server.js pour que `npm test` passe, sans modifier les tests.',
  }),
  codeProject({
    id: 'code-install-dep',
    title: 'Install an npm dependency and use it',
    green:
      'slugify is declared in package.json and installed in node_modules, src/slug.js imports it, every test of nodal-bench/slug-titre passes when the bench reruns it, the test files are untouched, and nobody was asked anything.',
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
    extraJudge(o) {
      const r: string[] = [];
      if (o.extra['declared'] !== true)
        r.push('slugify is not in the dependencies of package.json');
      if (o.extra['installed'] !== true) r.push('slugify is not installed in node_modules');
      if (o.extra['imports'] !== true) r.push('src/slug.js does not import slugify');
      return r;
    },
  }),
  codeProject({
    id: 'code-bugfix',
    title: 'Fix a bug that makes a test suite fail',
    green:
      'src/facture.js was changed, every test of nodal-bench/facture-tva passes when the bench reruns it, the test files are untouched, the agent ran the suite itself, and nobody was asked anything.',
    project: 'facture-tva',
    source: 'src/facture.js',
    instruction:
      `Les tests du projet nodal-bench/facture-tva ${SHARED} échouent. Trouve et corrige le ou ` +
      'les bugs dans src/facture.js pour que `npm test` passe, sans modifier les tests.',
    extraJudge(o) {
      return o.sourceHash === fileHash(join(fixturePath('code/facture-tva'), 'src', 'facture.js'))
        ? ['src/facture.js was not changed']
        : [];
    },
  }),
  codeData,
];
