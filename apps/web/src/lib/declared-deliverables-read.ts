// declared-deliverables-read.ts — les fichiers qu'un run a PROMIS et que sa
// preuve n'a pas conclus verts (issue #509).
//
// Le récapitulatif de livraison lit son verdict sur les lignes de preuve
// (`verification_runs`). Un fichier que l'agent a déclaré livrer mais dont la
// preuve n'a jamais conclu — génération périmée, panne d'infra, run arrêté
// entre la déclaration et la finalisation — n'y laisse aucune ligne rouge :
// le récapitulatif aurait dit « Verified » sur les seules sources. Cette
// lecture donne à l'écran ce qui manque, lu sur la ligne d'état elle-même.

import 'server-only';
import { and, eq, inArray, jobDeliverableVerificationState, ne } from '@nodal-agents/db';
import type { getDb } from './server.ts';
import type { ThreadDeclaredDeliverable } from './declared-proof.ts';

type Db = ReturnType<typeof getDb>;

/**
 * Par `job_id`, les livrables DÉCLARÉS dont l'état n'est pas `green`.
 *
 * Même borne d'entité que `readRepairAttempts` : celle des `jobIds`, déjà
 * bornés à la session par l'appelant.
 */
export async function readDeclaredUnverified(
  db: Db,
  jobIds: readonly string[],
): Promise<Map<string, ThreadDeclaredDeliverable[]>> {
  const out = new Map<string, ThreadDeclaredDeliverable[]>();
  if (jobIds.length === 0) return out;
  const rows = await db
    .select({
      jobId: jobDeliverableVerificationState.jobId,
      canonicalKey: jobDeliverableVerificationState.canonicalKey,
      displayPath: jobDeliverableVerificationState.displayPathSnapshot,
      decisionStatus: jobDeliverableVerificationState.decisionStatus,
    })
    .from(jobDeliverableVerificationState)
    .where(
      and(
        inArray(jobDeliverableVerificationState.jobId, [...jobIds]),
        eq(jobDeliverableVerificationState.declared, true),
        ne(jobDeliverableVerificationState.decisionStatus, 'green'),
      ),
    );
  for (const row of rows) {
    const bucket = out.get(row.jobId) ?? [];
    bucket.push({ path: row.displayPath ?? row.canonicalKey, status: row.decisionStatus });
    out.set(row.jobId, bucket);
  }
  return out;
}
