// repos/run-tree.ts — CE QU'EST un run, en un seul endroit.
//
// Un run, c'est un job de tête et tout ce qui en descend : ce qu'il a délégué
// (`parent_job_id`) et la tête que sa file a fait naître à sa fin
// (`relaunched_from_job_id`, #531 : la suite du même travail). Deux lecteurs
// en ont besoin et lisaient chacun leur arbre :
//   - l'arrêt (`cancelJobTree`, conversation-runs.ts), qui arrête un run ;
//   - le budget de run (`readRunCost`, run-cost.ts), qui en somme la dépense.
// Le second ne filtrait pas l'espace (revue de #836, passe 2) : `parent_job_id`
// n'a pas de clé étrangère, et un lien vers un job d'un autre espace aurait
// fait compter à un run la dépense d'un autre. Les deux passent maintenant
// ICI : mêmes liens, même borne à l'espace, à CHAQUE niveau.

import { and, eq, inArray, or } from 'drizzle-orm';
import type { AnyDrizzleDb } from '../client.ts';
import { agentJobs } from '../schema/jobs.ts';

/** Au-delà, un graphe corrompu (un cycle de `parent_job_id`) ne fait pas boucler une remontée. */
const MAX_HEAD_HOPS = 32;

/**
 * Les jobs de l'espace qui descendent de `fromIds`, ceux-ci compris : délégués
 * et têtes relancées, niveau par niveau. Avec `forUpdate`, chaque niveau est
 * VERROUILLÉ avant la lecture du suivant (le protocole de `cancelJobTree` :
 * aucun enfant ne naît sous un job qu'on arrête). L'ensemble des ids vus garde
 * la boucle finie, même sur un graphe corrompu.
 */
export async function descendRunTree(
  db: AnyDrizzleDb,
  entityId: string,
  fromIds: readonly string[],
  opts: { forUpdate?: boolean } = {},
): Promise<string[]> {
  const ids = new Set(fromIds);
  let frontier = [...fromIds];
  while (frontier.length > 0) {
    const level = db
      .select({ id: agentJobs.id })
      .from(agentJobs)
      .where(
        and(
          eq(agentJobs.entityId, entityId),
          or(
            inArray(agentJobs.parentJobId, frontier),
            inArray(agentJobs.relaunchedFromJobId, frontier),
          ),
        ),
      );
    const rows = opts.forUpdate ? await level.for('update') : await level;
    frontier = rows.map((r) => r.id).filter((id) => !ids.has(id));
    for (const id of frontier) ids.add(id);
  }
  return [...ids];
}

/**
 * La tête du run de `jobId` : on remonte `parent_job_id`, dans l'espace
 * seulement (comme `readJobRoots` côté web). Un parent d'un autre espace, ou
 * absent, arrête la remontée : le job où elle s'arrête est la tête. On ne
 * remonte PAS `relaunched_from_job_id` : une tête relancée commence un run
 * qui est la suite du précédent, et l'arrêt du précédent la couvre, pas
 * l'inverse.
 */
export async function runHeadOf(
  db: AnyDrizzleDb,
  entityId: string,
  jobId: string,
): Promise<string> {
  let head = jobId;
  const seen = new Set<string>([jobId]);
  for (let hop = 0; hop < MAX_HEAD_HOPS; hop++) {
    const [row] = await db
      .select({ parentJobId: agentJobs.parentJobId })
      .from(agentJobs)
      .where(and(eq(agentJobs.id, head), eq(agentJobs.entityId, entityId)))
      .limit(1);
    const parent = row?.parentJobId ?? null;
    if (parent === null || seen.has(parent)) break;
    const [inSpace] = await db
      .select({ id: agentJobs.id })
      .from(agentJobs)
      .where(and(eq(agentJobs.id, parent), eq(agentJobs.entityId, entityId)))
      .limit(1);
    if (!inSpace) break;
    seen.add(parent);
    head = parent;
  }
  return head;
}
