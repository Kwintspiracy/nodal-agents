// job/run-budget.ts — le budget de run de l'espace, pour les DEUX chemins d'un job.
//
// Un job tourne soit dans la boucle de Nodal (job/execute.ts), soit dans une
// CLI de code (cli-runtime/run-job.ts). Le budget de run de l'espace
// (`entities.max_run_cost_usd`, #442) borne le RUN, c'est-à-dire tout l'arbre
// de délégation (revue de #836, P1) : les deux chemins le lisent ici, et
// aucun ne démarre un appel ou un tour sur un run qui a déjà dépensé son
// plafond.

import { eq, entities, readRunCost, runSpentUsd } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { DEFAULT_LIMITS } from '@nodal-agents/orchestration';

/**
 * Le plafond de coût d'un run, depuis le réglage de l'espace (#442).
 * `0` = aucun plafond ; une ligne d'espace absente garde le défaut de la
 * plateforme, qui est aussi le défaut de la colonne.
 */
export function runCostCeilingUsd(
  settingUsd: number | null | undefined,
  defaultUsd: number,
): number {
  if (settingUsd === null || settingUsd === undefined) return defaultUsd;
  return settingUsd > 0 ? settingUsd : Infinity;
}

/** Le plafond de coût d'un run de cet espace. */
export async function readRunCostCeilingUsd(
  db: AnyDrizzleDb,
  entityId: string | null,
): Promise<number> {
  // Un job sans espace (un appelant interne de /api/agent) n'a pas de ligne de
  // réglages : le défaut de la plateforme, comme pour une ligne absente.
  if (!entityId) return runCostCeilingUsd(undefined, DEFAULT_LIMITS.maxCostPerJobUsd);
  const [row] = await db
    .select({ maxRunCostUsd: entities.maxRunCostUsd })
    .from(entities)
    .where(eq(entities.id, entityId))
    .limit(1);
  return runCostCeilingUsd(row?.maxRunCostUsd, DEFAULT_LIMITS.maxCostPerJobUsd);
}

/**
 * Ce que le run de `jobId` a dépensé : les autres jobs de son arbre, tels
 * qu'ils l'ont écrit, plus `ownUsd`, la dépense en mémoire de ce job.
 */
export async function readRunSpentUsd(
  db: AnyDrizzleDb,
  jobId: string,
  ownUsd: number,
): Promise<number> {
  return runSpentUsd(await readRunCost(db, jobId), jobId, ownUsd);
}
