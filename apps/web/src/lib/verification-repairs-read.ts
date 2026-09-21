// verification-repairs-read.ts — la LECTURE des tours de réparation (#375).
//
// Séparée de `verification-repairs.ts` pour une raison mécanique, pas
// esthétique : le filtre de séquences sert aussi au détail de la page Code,
// que `CodeProcessDetail` rend côté client. Une seule ligne `server-only` dans
// ce module-là aurait fait entrer le pilote Postgres dans le bundle du
// navigateur.

import 'server-only';
import { inArray, jobDeliverableVerificationState } from '@nodal-agents/db';
import type { getDb } from './server.ts';

type Db = ReturnType<typeof getDb>;

/**
 * Combien de tours de réparation chaque job a coûté, par `job_id`.
 *
 * LU, JAMAIS DÉDUIT : le nombre de séquences de preuve ne dirait pas la même
 * chose, une preuve immédiate de `code_task` en créant une sans qu'aucune
 * réparation n'ait eu lieu. La colonne, elle, n'est écrite que par la
 * finalisation quand elle rouvre le run.
 *
 * LA BORNE D'ENTITÉ EST CELLE DES `jobIds`, et c'est voulu : la table ne porte
 * pas de colonne d'entité, elle appartient à son job. Les deux appelants
 * passent des identifiants déjà bornés à la session (`collectDescendants(db,
 * session.entityId, …)`), exactement comme la lecture voisine des livrables
 * non configurés, qui filtre elle aussi sur le seul `job_id`.
 *
 * Un job absent de la carte n'en a coûté aucun — la colonne vaut zéro par
 * défaut, et on ne rapporte que ce qui est strictement positif. Un job qui
 * porte plusieurs livrables rend le plus grand : le run a été rejoué une fois,
 * que ce soit pour un projet ou pour trois.
 */
export async function readRepairAttempts(
  db: Db,
  jobIds: readonly string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (jobIds.length === 0) return out;
  const rows = await db
    .select({
      jobId: jobDeliverableVerificationState.jobId,
      repairAttempts: jobDeliverableVerificationState.repairAttempts,
    })
    .from(jobDeliverableVerificationState)
    .where(inArray(jobDeliverableVerificationState.jobId, [...jobIds]));
  for (const row of rows) {
    if (row.repairAttempts <= 0) continue;
    out.set(row.jobId, Math.max(out.get(row.jobId) ?? 0, row.repairAttempts));
  }
  return out;
}
