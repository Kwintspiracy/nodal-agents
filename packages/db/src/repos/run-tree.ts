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
 * La tête du run de `jobId` : on remonte les MÊMES liens que la descente,
 * `parent_job_id` (le job qui l'a délégué) et `relaunched_from_job_id` (le job
 * dont la file l'a fait naître, #531), dans l'espace seulement (comme
 * `readJobRoots` côté web). Un lien vers un autre espace, ou vers un job
 * absent, arrête la remontée : le job où elle s'arrête est la tête.
 *
 * Le run est ainsi UN ensemble, symétrique (revue de #836, passe 3) : depuis
 * n'importe quel job d'une chaîne de relances et de délégations, la même tête
 * et le même arbre. Une continuation partage le budget du run qu'elle continue.
 *
 * La remontée a les MÊMES bornes que la descente (revue de #836, passe 4) :
 * l'espace, et l'ensemble des ids vus, qui arrête un cycle d'un graphe
 * corrompu. Aucun nombre de sauts : une file restée pleine relance une tête à
 * chaque fin, et une chaîne légitime s'allonge d'un maillon par relance. Elle
 * plafonnait à 32 ; le dernier job d'une chaîne plus longue lisait alors un run
 * plus court que le premier, et le plafond revenait tous les 32 maillons.
 */
export async function runHeadOf(
  db: AnyDrizzleDb,
  entityId: string,
  jobId: string,
): Promise<string> {
  // Les liens d'un job de l'espace, ou null quand il n'y est pas (absent, ou
  // dans un autre espace) : une lecture par maillon.
  const linksOf = async (id: string) => {
    const [row] = await db
      .select({ parentJobId: agentJobs.parentJobId, relaunchedFrom: agentJobs.relaunchedFromJobId })
      .from(agentJobs)
      .where(and(eq(agentJobs.id, id), eq(agentJobs.entityId, entityId)))
      .limit(1);
    return row ?? null;
  };
  let head = jobId;
  let links = await linksOf(jobId);
  const seen = new Set<string>([jobId]);
  for (;;) {
    const parent = links?.parentJobId ?? links?.relaunchedFrom ?? null;
    if (parent === null || seen.has(parent)) break;
    const parentLinks = await linksOf(parent);
    if (parentLinks === null) break;
    seen.add(parent);
    head = parent;
    links = parentLinks;
  }
  return head;
}
