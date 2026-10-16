// workflows/matrix.ts — chaque scénario, une fois par modèle.
//
// `--models a,b,c` joue chaque scénario retenu une fois par modèle (fois
// `--trials`). COMMENT un modèle est appliqué à un essai est une décision du
// propriétaire, encore ouverte (15/10) : une entité « banc » avec sa propre
// copie de l'équipe, ou les agents du propriétaire eux-mêmes. Il n'existe
// aujourd'hui aucun choix de modèle par job (`agents.model` seulement).
//
// Tant que la décision n'est pas prise, le banc ne change AUCUN agent et ne
// crée AUCUNE entité : la couture est `ModelApplier`, une seule fonction, et
// la seule implémentation est celle qui refuse en le disant. Le mode
// `--dry-run` imprime le plan (scénario × modèle × essais) et son coût estimé,
// sans toucher à la stack.

import { existsSync, readFileSync } from 'node:fs';
import { RESULTS_FILE } from './paths';
import { estimateCallCostUsd, findModelCatalogEntry, MODEL_CATALOG } from '@nodal-agents/shared';
import { ACTIVITIES, type AnyScenario, type TrialLine } from './types';

/** Un modèle de la matrice : `fournisseur:modèle`, ou le modèle seul quand le catalogue n'en connaît qu'un. */
export interface MatrixModel {
  readonly provider: string;
  readonly model: string;
}

/**
 * Lit `--models`. Chaque entrée est `fournisseur:modèle` (`openrouter:z-ai/glm-5.3`)
 * ou un modèle seul, que le catalogue doit connaître chez UN seul fournisseur.
 * Un modèle inconnu ou ambigu est une erreur, jamais un choix fait à la place
 * du propriétaire.
 */
export function parseModels(
  arg: string,
  catalog: Record<string, ReadonlyArray<{ modelId: string }>> = MODEL_CATALOG,
): MatrixModel[] {
  const out: MatrixModel[] = [];
  for (const raw of arg
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)) {
    const colon = raw.indexOf(':');
    if (colon > 0) {
      out.push({ provider: raw.slice(0, colon), model: raw.slice(colon + 1) });
      continue;
    }
    const providers = Object.entries(catalog)
      .filter(([, entries]) => entries.some((e) => e.modelId === raw))
      .map(([p]) => p);
    if (providers.length === 0) {
      throw new Error(
        `workflow_unknown_model: ${raw} is in no provider of the model catalog; write it provider:model`,
      );
    }
    if (providers.length > 1) {
      throw new Error(
        `workflow_ambiguous_model: ${raw} is served by ${providers.join(', ')}; write it provider:model`,
      );
    }
    out.push({ provider: providers[0]!, model: raw });
  }
  if (out.length === 0) throw new Error('workflow_no_model: --models names no model');
  const keys = out.map(modelKey);
  const twice = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (twice.length > 0) throw new Error(`workflow_model_twice: ${[...new Set(twice)].join(', ')}`);
  return out;
}

export function modelKey(m: MatrixModel): string {
  return `${m.provider}:${m.model}`;
}

// ─── La couture ──────────────────────────────────────────────────────────────

/**
 * Comment un modèle est appliqué à un essai, et défait après. LA couture de la
 * matrice : le jour où le propriétaire décide (entité « banc » ou ses agents),
 * c'est la seule pièce qui change.
 */
export interface ModelApplier {
  readonly name: string;
  apply(model: MatrixModel): Promise<{ restore(): Promise<void> }>;
}

/** La seule implémentation d'aujourd'hui : elle refuse, et dit pourquoi. */
export const UNDECIDED_APPLIER: ModelApplier = {
  name: 'undecided',
  apply(model) {
    return Promise.reject(
      new Error(
        `workflow_matrix_undecided: running ${modelKey(model)} needs a decision of the owner ` +
          "(a separate bench workspace with its own copy of the team, or the owner's agents); " +
          'until then the bench changes no agent and creates no workspace. Use --dry-run to see the plan.',
      ),
    );
  },
};

// ─── Le plan ─────────────────────────────────────────────────────────────────

export function median(values: ReadonlyArray<number | null | undefined>): number | null {
  const v = values
    .filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
    .sort((a, b) => a - b);
  if (v.length === 0) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
}

/** Ce que le plan lit d'une ligne passée ; `cachedTokens` manque aux lignes d'avant la v2. */
export type PastLine = Pick<
  TrialLine,
  'scenario' | 'scenarioVersion' | 'durationMs' | 'inputTokens' | 'outputTokens' | 'verdict'
> & { readonly cachedTokens?: number | null };

export interface PlanCell {
  readonly scenario: string;
  readonly activity: string;
  readonly model: string;
  readonly trials: number;
  /** Les essais passés de la version courante du scénario qui ont mesuré leurs jetons. */
  readonly pastRuns: number;
  readonly medianDurationMs: number | null;
  readonly medianInputTokens: number | null;
  readonly medianOutputTokens: number | null;
  /** Coût estimé de TOUS les essais de la cellule ; null quand il ne peut pas l'être (voir `why`). */
  readonly estimatedUsd: number | null;
  readonly why: string | null;
}

export interface MatrixPlan {
  readonly cells: PlanCell[];
  readonly trials: number;
  /** Somme des coûts estimés, et le nombre de cellules qui n'en ont pas. */
  readonly knownUsd: number;
  readonly unknownCells: number;
  /** Somme des durées médianes connues (essais joués l'un après l'autre). */
  readonly knownDurationMs: number;
}

/**
 * Le plan de la matrice. Le coût d'une cellule = prix du catalogue appliqué aux
 * médianes des essais passés du scénario (sa version courante, tous modèles
 * confondus : c'est la taille de la tâche, pas celle d'un modèle), fois le
 * nombre d'essais. Sans essai passé ou sans prix au catalogue, le coût est
 * ABSENT et la raison est dite : jamais un zéro.
 */
export function planMatrix(
  scenarios: readonly AnyScenario[],
  models: readonly MatrixModel[],
  trials: number,
  past: readonly PastLine[],
): MatrixPlan {
  const cells: PlanCell[] = [];
  // Rangés par activité, dans l'ordre de la liste fermée : une activité, un bloc.
  const ordered = [...scenarios].sort(
    (a, b) => ACTIVITIES.indexOf(a.activity) - ACTIVITIES.indexOf(b.activity),
  );
  for (const s of ordered) {
    const runs = past.filter(
      (l) =>
        l.scenario === s.id &&
        l.scenarioVersion === s.version &&
        (l.verdict === 'green' || l.verdict === 'red') &&
        typeof l.inputTokens === 'number' &&
        typeof l.outputTokens === 'number',
    );
    const medIn = median(runs.map((l) => l.inputTokens));
    const medOut = median(runs.map((l) => l.outputTokens));
    const cachedKnown = runs.filter((l) => typeof l.cachedTokens === 'number');
    const medCached =
      cachedKnown.length === runs.length ? median(runs.map((l) => l.cachedTokens)) : null;
    const medDur = median(runs.map((l) => l.durationMs));
    for (const m of models) {
      const pricing = findModelCatalogEntry(m.provider, m.model)?.pricing;
      let estimatedUsd: number | null = null;
      let why: string | null = null;
      if (runs.length === 0 || medIn === null || medOut === null)
        why = 'no past run of this scenario version';
      else if (!pricing) why = `no catalog price for ${modelKey(m)}`;
      else {
        const one = estimateCallCostUsd(m.provider, m.model, {
          inputTokens: medIn,
          outputTokens: medOut,
          cachedTokens: medCached ?? 0,
        });
        estimatedUsd = Number((one * trials).toFixed(4));
      }
      cells.push({
        scenario: s.id,
        activity: s.activity,
        model: modelKey(m),
        trials,
        pastRuns: runs.length,
        medianDurationMs: medDur,
        medianInputTokens: medIn,
        medianOutputTokens: medOut,
        estimatedUsd,
        why,
      });
    }
  }
  return {
    cells,
    trials,
    knownUsd: Number(cells.reduce((t, c) => t + (c.estimatedUsd ?? 0), 0).toFixed(4)),
    unknownCells: cells.filter((c) => c.estimatedUsd === null).length,
    knownDurationMs: cells.reduce((t, c) => t + (c.medianDurationMs ?? 0) * c.trials, 0),
  };
}

function minutes(ms: number | null): string {
  return ms === null ? '?' : `${Math.max(1, Math.round(ms / 60_000))} min`;
}

/** Le plan, lisible dans un terminal. */
export function formatPlan(plan: MatrixPlan, models: readonly MatrixModel[]): string {
  const lines: string[] = [];
  const scenarios = [...new Set(plan.cells.map((c) => c.scenario))];
  lines.push(
    `Model matrix (dry run): ${scenarios.length} scenario(s) × ${models.length} model(s) × ${plan.trials} trial(s) = ${plan.cells.length * plan.trials} trial(s)`,
  );
  lines.push('Nothing is run, no agent is changed.\n');
  let activity = '';
  for (const c of plan.cells) {
    if (c.activity !== activity) {
      activity = c.activity;
      lines.push(`[${activity}]`);
    }
    const cost =
      c.estimatedUsd === null ? `cost unknown (${c.why})` : `≈ $${c.estimatedUsd.toFixed(3)}`;
    lines.push(
      `  ${c.scenario.padEnd(28)} ${c.model.padEnd(36)} ×${c.trials}  ${cost}  · median ${minutes(c.medianDurationMs)} over ${c.pastRuns} past run(s)`,
    );
  }
  lines.push(
    `\nEstimated cost: $${plan.knownUsd.toFixed(3)}${plan.unknownCells > 0 ? ` plus ${plan.unknownCells} cell(s) with no estimate` : ''}.`,
  );
  lines.push(
    `Estimated time, trials one after the other: ${minutes(plan.knownDurationMs)} for the cells with a past run.`,
  );
  return lines.join('\n');
}

/** Les lignes passées de workflows.ndjson, pour les médianes du plan. Une ligne illisible est comptée et dite. */
export function readPastLines(file: string = RESULTS_FILE): {
  lines: PastLine[];
  unreadable: number;
} {
  if (!existsSync(file)) return { lines: [], unreadable: 0 };
  const lines: PastLine[] = [];
  let unreadable = 0;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    if (!raw.trim()) continue;
    try {
      lines.push(JSON.parse(raw) as PastLine);
    } catch {
      unreadable++;
    }
  }
  return { lines, unreadable };
}
