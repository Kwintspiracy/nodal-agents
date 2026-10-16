// studio/data.ts — ce que Bench Studio montre, lu par les modules du banc eux-mêmes.
//
// Aucune seconde implémentation (règle 11) : le catalogue vient de catalog.ts,
// les besoins de needs.ts, le plan de matrix.ts et selection.ts, les résultats
// de results.ts (le même code que le portail), les fixtures de fixtures.ts.
// Ce module ne fait que rassembler et rendre du JSON.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { buildCatalog, type Catalog } from '../workflows/catalog';
import { FIXTURES_DIR } from '../workflows/fixtures';
import { planMatrix, parseModels, readPastLines, type MatrixPlan } from '../workflows/matrix';
import { needReport } from '../workflows/needs';
import { RESULTS_FILE } from '../workflows/paths';
import { colonneDe, construireMatrice, lireWorkflows, type ResultLine } from '../workflows/results';
import { assertMatrixable, selectScenarios, type Selection } from '../workflows/selection';
import type { ScenarioEnv } from '../workflows/types';

// ─── Catalogue ───────────────────────────────────────────────────────────────

export interface FixtureFile {
  /** Relatif à packages/bench/fixtures, en barres obliques. */
  readonly path: string;
  readonly bytes: number;
}

export interface StudioCatalog extends Catalog {
  /** Pour chaque scénario, les fichiers que ses fixtures posent (un dossier est déplié). */
  readonly fixtureFiles: Record<string, FixtureFile[]>;
}

function filesOf(rel: string): FixtureFile[] {
  const abs = join(FIXTURES_DIR, rel);
  if (!existsSync(abs)) return [];
  if (statSync(abs).isFile()) return [{ path: rel, bytes: statSync(abs).size }];
  return readdirSync(abs, { withFileTypes: true }).flatMap((e) =>
    filesOf(`${rel}/${e.name}`).filter((f) => !f.path.includes('/node_modules/')),
  );
}

export function studioCatalog(): StudioCatalog {
  const catalog = buildCatalog();
  const fixtureFiles: Record<string, FixtureFile[]> = {};
  for (const s of catalog.scenarios)
    fixtureFiles[s.id] = s.fixtures.flatMap((f) => filesOf(f.from));
  return { ...catalog, fixtureFiles };
}

const TEXT = new Set(['.md', '.csv', '.html', '.js', '.json', '.txt', '.ts', '.py']);

/**
 * Une fixture, pour la regarder : le texte d'un fichier texte, sinon sa taille
 * et son type. Seulement sous packages/bench/fixtures : tout autre chemin est
 * refusé.
 */
export function readFixture(
  rel: string,
): { kind: 'text'; text: string } | { kind: 'binary'; bytes: number; type: string } {
  const abs = resolve(FIXTURES_DIR, rel);
  if (!abs.startsWith(resolve(FIXTURES_DIR) + sep) || !existsSync(abs) || !statSync(abs).isFile()) {
    throw new Error(`studio_no_fixture: ${rel} is not a fixture file`);
  }
  const ext = extname(abs).toLowerCase();
  if (TEXT.has(ext)) return { kind: 'text', text: readFileSync(abs, 'utf8') };
  return { kind: 'binary', bytes: statSync(abs).size, type: ext.slice(1) };
}

/** Le chemin d'une fixture, relatif au dossier des fixtures (pour les liens). */
export function fixtureRel(abs: string): string {
  return relative(FIXTURES_DIR, abs).split(sep).join('/');
}

// ─── Besoins ─────────────────────────────────────────────────────────────────

export type NeedsView =
  | { readonly reachable: true; readonly needs: Array<{ need: string; missing: string | null }> }
  | { readonly reachable: false; readonly why: string };

/** L'état des besoins dans l'environnement lu ; la stack injoignable est dite, jamais « tout va bien ». */
export async function studioNeeds(readEnv: () => Promise<ScenarioEnv>): Promise<NeedsView> {
  try {
    return { reachable: true, needs: needReport(await readEnv()) };
  } catch (e) {
    return { reachable: false, why: String(e instanceof Error ? e.message : e) };
  }
}

// ─── Plan ────────────────────────────────────────────────────────────────────

export interface PlanRequest {
  readonly selection: Selection;
  /** `fournisseur:modèle`, séparés par des virgules ; vide : les agents sur leurs propres modèles. */
  readonly models: string;
  readonly trials: number;
}

export interface PlanView {
  readonly scenarios: string[];
  readonly trials: number;
  /** null : aucun modèle imposé, les agents tournent sur les leurs (pas de prix à appliquer). */
  readonly plan: MatrixPlan | null;
  readonly unreadableLines: number;
}

export function studioPlan(req: PlanRequest): PlanView {
  if (!Number.isInteger(req.trials) || req.trials < 1 || req.trials > 20)
    throw new Error('studio_bad_trials: trials must be an integer from 1 to 20');
  const scenarios = selectScenarios(req.selection);
  if (scenarios.length === 0) throw new Error('studio_no_scenario: the selection is empty');
  const past = readPastLines();
  if (!req.models.trim()) {
    return {
      scenarios: scenarios.map((s) => s.id),
      trials: req.trials,
      plan: null,
      unreadableLines: past.unreadable,
    };
  }
  const models = parseModels(req.models);
  assertMatrixable(scenarios);
  return {
    scenarios: scenarios.map((s) => s.id),
    trials: req.trials,
    plan: planMatrix(scenarios, models, req.trials, past.lines),
    unreadableLines: past.unreadable,
  };
}

// ─── Résultats ───────────────────────────────────────────────────────────────

/** Une ligne d'essai, avec son numéro dans le fichier : l'identifiant stable de sa page. */
export interface NumberedLine {
  readonly n: number;
  readonly line: ResultLine;
}

export function readResultLines(file: string = RESULTS_FILE): {
  lines: NumberedLine[];
  unreadable: number;
} {
  if (!existsSync(file)) return { lines: [], unreadable: 0 };
  const lines: NumberedLine[] = [];
  let unreadable = 0;
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((raw, i) => {
      if (!raw.trim()) return;
      const one = lireWorkflows(raw);
      if (one.lignes.length === 1) lines.push({ n: i + 1, line: one.lignes[0]! });
      else unreadable++;
    });
  return { lines, unreadable };
}

/** La matrice, rendue en JSON (les Map deviennent des tableaux). */
export function studioResults(file: string = RESULTS_FILE) {
  const { lines, unreadable } = readResultLines(file);
  const m = construireMatrice(
    lines.map((l) => l.line),
    buildCatalog(),
  );
  const numberOf = new Map(lines.map((l) => [l.line, l.n]));
  return {
    unreadable,
    columns: m.colonnes,
    period: m.periode,
    summaries: m.colonnes.map((c) => ({ column: c, ...m.resumes.get(c)! })),
    activities: m.activites.map((a) => ({
      activity: a.activite,
      scenarios: a.scenarios.map((s) => ({
        id: s.id,
        version: s.version,
        title: s.titre,
        needs: [...s.besoins],
        cells: [...s.cellules.entries()].map(([column, c]) => ({
          column,
          tried: c.essais,
          skipped: c.sautes,
          green: c.verts,
          medianMs: c.dureeMs,
          medianUsd: c.coutUsd,
          last: c.derniers.map((l) => ({
            n: numberOf.get(l) ?? null,
            verdict: l.verdict,
            startedAt: l.startedAt ?? null,
            reasons: Array.isArray(l['reasons']) ? (l['reasons'] as string[]) : [],
          })),
        })),
      })),
    })),
  };
}

/** Un essai, par son numéro de ligne dans workflows.ndjson. */
export function studioTrial(n: number, file: string = RESULTS_FILE) {
  const hit = readResultLines(file).lines.find((l) => l.n === n);
  if (!hit) throw new Error(`studio_no_trial: no trial on line ${n}`);
  return { n, column: colonneDe(hit.line), line: hit.line };
}
