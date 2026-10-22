// cron/take-lost-run.ts — LA règle des faucheurs pour les processus d'un run
// perdu (#750, revues 1 et 2 de #834).
//
// Du code de FAUCHEUR, pas de run : il écrit la ligne d'un job que plus aucun
// run vivant ne tient, et c'est pour cela qu'il vit ici, hors des racines
// « run » que garde own-job-row.test.ts — comme les faucheurs qui l'appellent.

import { and, eq, lt, sql } from '@nodal-agents/db';
import { agentJobs } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { releaseProcessesOfLostJob } from '../job/process-scopes.ts';

/** Ce qu'un faucheur a lu d'un job qu'il juge perdu : l'état sur lequel il décide. */
export interface LostRunSeen {
  readonly id: string;
  readonly status: string;
  /** La prise du run jugé perdu (`agent_jobs.claim_generation`, #566). */
  readonly claimGeneration: number;
}

/**
 * LA RÈGLE DES FAUCHEURS (#750, revues 1 et 2 de #834) : « ce run est perdu »
 * et « ses processus meurent » sont UN seul fait.
 *
 * La libération tue par identifiant de JOB (son périmètre, son étiquette) ;
 * la décision, elle, porte sur un RUN. Les deux se rejoignent par la prise
 * (`claim_generation`), le mécanisme qui dit déjà quel run tient un job :
 *   1. le faucheur PREND la ligne au run qu'il a jugé perdu, par une écriture
 *      conditionnée sur exactement ce qu'il a lu — même statut, même prise,
 *      toujours sans battement depuis `staleBefore`. La prise monte d'un cran,
 *      comme quand un worker prend un job : le run perdu, s'il vit encore,
 *      n'a plus le droit d'agir (il relit sa prise avant chaque effet) ; une
 *      ligne prenable (`pending`) devient `processing`, et aucun worker ne
 *      peut plus la prendre ;
 *   2. SEULEMENT si cette écriture a pris, ses processus meurent — personne
 *      ne peut plus lancer de commande pour ce job ;
 *   3. le faucheur écrit ensuite la ligne finale (échec, ou remise en file
 *      sous SA prise, rendue en dernier).
 * Si le run est revenu entre la lecture et l'écriture (il s'est remis en
 * file, suspendu, un worker l'a pris, son battement est reparti), la prise
 * refuse : rien n'est tué, rien n'est écrit. Rend la prise du faucheur, ou
 * `null`.
 */
export async function takeLostRun(
  db: AnyDrizzleDb,
  seen: LostRunSeen,
  staleBefore: Date,
): Promise<number | null> {
  const rows = await db
    .update(agentJobs)
    .set({
      // Une ligne prenable est prise, comme `claimJob` la prend ; une autre
      // garde son statut — elle n'était déjà prenable par personne.
      status: seen.status === 'pending' ? 'processing' : seen.status,
      claimGeneration: sql`${agentJobs.claimGeneration} + 1`,
    })
    .where(
      and(
        eq(agentJobs.id, seen.id),
        eq(agentJobs.status, seen.status),
        eq(agentJobs.claimGeneration, seen.claimGeneration),
        lt(agentJobs.updatedAt, staleBefore),
      ),
    )
    .returning({ claimGeneration: agentJobs.claimGeneration });
  const taken = rows[0];
  if (rows.length !== 1 || !taken) return null;
  await releaseProcessesOfLostJob(seen.id);
  return taken.claimGeneration;
}
