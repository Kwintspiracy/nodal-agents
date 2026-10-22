// repos/run-cost.ts — ce qu'un RUN a coûté : sa tête et tout ce qui en descend.
//
// Le budget de run de l'espace (`entities.max_run_cost_usd`, Settings → Run
// budget, #442) promet : « A run stops once it has cost $X ». Il était
// pourtant vérifié par JOB (Guard 1e, apps/runner/src/job/execute.ts) : chaque
// délégué repartait avec le plafond entier, et un arbre de trois jobs pouvait
// coûter trois fois le plafond (revue de #836, P1). Le run est celui que
// l'arrêt arrête : UNE définition, `run-tree.ts` (la tête par `parent_job_id`,
// puis tout ce qui en descend, délégués et têtes relancées), bornée à
// l'espace du job à chaque niveau (revue de #836, passe 2).
//
// La dépense de chaque job est celle qu'il a écrite à son dernier point de
// reprise (`saveCheckpoint`, à chaque tour) : un job vivant y ajoute la sienne,
// en mémoire, plus fraîche (`runSpentUsd`). Un coût inconnu (`NULL`, un
// fournisseur qui ne le rapporte pas et aucun prix au catalogue) compte zéro,
// comme pour la garde d'un job seul : le plafond de jetons reste le filet.

import { and, eq, inArray } from 'drizzle-orm';
import type { AnyDrizzleDb } from '../client.ts';
import { agentJobs } from '../schema/jobs.ts';
import { descendRunTree, runHeadOf } from './run-tree.ts';

export interface RunCost {
  /** La tête du run (le job sans parent dans l'espace), ou le job lui-même quand sa chaîne sort de l'espace. */
  readonly headJobId: string;
  /** Chaque job du run et la dépense qu'il a écrite (0 quand elle est inconnue). */
  readonly jobs: ReadonlyArray<{ readonly id: string; readonly costUsd: number }>;
}

/** Le run de `jobId`, dans son espace : sa tête, puis tout ce qui en descend. */
export async function readRunCost(db: AnyDrizzleDb, jobId: string): Promise<RunCost> {
  const [self] = await db
    .select({ entityId: agentJobs.entityId })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId))
    .limit(1);
  const entityId = self?.entityId ?? null;
  // Un job sans espace n'appartient à l'arbre d'aucun autre : son run, c'est lui.
  if (entityId === null) return { headJobId: jobId, jobs: [] };

  const headJobId = await runHeadOf(db, entityId, jobId);
  const ids = await descendRunTree(db, entityId, [headJobId]);
  const rows = await db
    .select({ id: agentJobs.id, costUsd: agentJobs.totalCostUsd })
    .from(agentJobs)
    .where(and(eq(agentJobs.entityId, entityId), inArray(agentJobs.id, ids)));
  return {
    headJobId,
    jobs: rows.map((r) => ({ id: r.id, costUsd: typeof r.costUsd === 'number' ? r.costUsd : 0 })),
  };
}

/**
 * La dépense du run vue par un de ses jobs vivants : celle que les AUTRES jobs
 * ont écrite, plus la sienne en mémoire (`ownUsd`), plus fraîche que sa ligne.
 */
export function runSpentUsd(run: RunCost, jobId: string, ownUsd: number): number {
  return run.jobs.reduce((t, j) => (j.id === jobId ? t : t + j.costUsd), 0) + ownUsd;
}
