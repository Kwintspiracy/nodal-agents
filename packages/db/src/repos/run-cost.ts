// repos/run-cost.ts — ce qu'un RUN a coûté : sa tête et tout ce qu'elle a délégué.
//
// Le budget de run de l'espace (`entities.max_run_cost_usd`, Settings → Run
// budget, #442) promet : « A run stops once it has cost $X ». Il était
// pourtant vérifié par JOB (Guard 1e, apps/runner/src/job/execute.ts) : chaque
// délégué repartait avec le plafond entier, et un arbre de trois jobs pouvait
// coûter trois fois le plafond (revue de #836, P1). Le run, c'est l'arbre de
// délégation : la tête (le job sans `parent_job_id`) et ses descendants par
// `parent_job_id`, l'unité que l'arrêt (`cancelJobTree`) arrête déjà. Ce
// module en lit la dépense, pour que la garde la compare au plafond.
//
// La dépense de chaque job est celle qu'il a écrite à son dernier point de
// reprise (`saveCheckpoint`, à chaque tour) : un job vivant y ajoute la sienne,
// en mémoire, plus fraîche (`runSpentUsd`). Un coût inconnu (`NULL`, un
// fournisseur qui ne le rapporte pas et aucun prix au catalogue) compte zéro,
// comme pour la garde d'un job seul : le plafond de jetons reste le filet.

import { eq, inArray } from 'drizzle-orm';
import type { AnyDrizzleDb } from '../client.ts';
import { agentJobs } from '../schema/jobs.ts';

/** Au-delà, un graphe corrompu (un cycle de `parent_job_id`) ne fait pas boucler la lecture. */
const MAX_TREE_DEPTH = 32;

export interface RunCost {
  /** La tête du run (le job sans parent), ou le job lui-même quand sa chaîne est rompue. */
  readonly headJobId: string;
  /** Chaque job du run et la dépense qu'il a écrite (0 quand elle est inconnue). */
  readonly jobs: ReadonlyArray<{ readonly id: string; readonly costUsd: number }>;
}

/** Le run de `jobId` : remonte à sa tête, puis descend tout ce qu'elle a délégué. */
export async function readRunCost(db: AnyDrizzleDb, jobId: string): Promise<RunCost> {
  let headJobId = jobId;
  const seen = new Set<string>([jobId]);
  for (let depth = 0; depth < MAX_TREE_DEPTH; depth++) {
    const [row] = await db
      .select({ parentJobId: agentJobs.parentJobId })
      .from(agentJobs)
      .where(eq(agentJobs.id, headJobId))
      .limit(1);
    const parent = row?.parentJobId ?? null;
    if (parent === null || seen.has(parent)) break;
    seen.add(parent);
    headJobId = parent;
  }

  const jobs: Array<{ id: string; costUsd: number }> = [];
  const inTree = new Set<string>();
  let frontier = [headJobId];
  for (let depth = 0; frontier.length > 0 && depth < MAX_TREE_DEPTH; depth++) {
    const rows = await db
      .select({ id: agentJobs.id, costUsd: agentJobs.totalCostUsd })
      .from(agentJobs)
      .where(inArray(agentJobs.id, frontier));
    for (const r of rows) {
      if (inTree.has(r.id)) continue;
      inTree.add(r.id);
      jobs.push({ id: r.id, costUsd: typeof r.costUsd === 'number' ? r.costUsd : 0 });
    }
    const children = await db
      .select({ id: agentJobs.id })
      .from(agentJobs)
      .where(inArray(agentJobs.parentJobId, frontier));
    frontier = children.map((c) => c.id).filter((id) => !inTree.has(id));
  }
  return { headJobId, jobs };
}

/**
 * La dépense du run vue par un de ses jobs vivants : celle que les AUTRES jobs
 * ont écrite, plus la sienne en mémoire (`ownUsd`), plus fraîche que sa ligne.
 */
export function runSpentUsd(run: RunCost, jobId: string, ownUsd: number): number {
  return run.jobs.reduce((t, j) => (j.id === jobId ? t : t + j.costUsd), 0) + ownUsd;
}
