// verification-repairs.ts — ce qu'une preuve REJOUÉE change pour les écrans
// (issue #375).
//
// Depuis que le runner rouvre un run sur une preuve rouge pour un tour de
// réparation, un même livrable peut porter DEUX séquences dans
// `verification_runs` : celle qui a rougi, et celle qui a suivi la correction.
// Les écrans qui comptent les commandes et concluent « Proof passed » ou
// « Proof failed » les additionnaient toutes. Le résultat se lisait à l'envers
// d'un run parfaitement vert : « 1 / 2 » et « Proof failed », alors qu'une
// seule commande existe et qu'elle passe.
//
// Deux gestes, et ils vivent ICI parce que deux écrans les font (le fil d'une
// conversation, la page d'un run) et qu'une seconde copie divergerait au
// premier correctif :
//
//   `lastSequencePerDeliverable` — ne garder que la DERNIÈRE séquence de
//   chaque livrable, celle qui dit où on en est ;
//   `readRepairAttempts` — combien de tours de réparation chaque job a coûté,
//   lu sur `job_deliverable_verification_state.repair_attempts`, la colonne
//   que la finalisation écrit. Jamais déduit du nombre de séquences : une
//   preuve immédiate de `code_task` en crée une sans qu'aucune réparation
//   n'ait eu lieu.

import 'server-only';
import { inArray, jobDeliverableVerificationState } from '@nodal-agents/db';
import type { getDb } from './server.ts';

type Db = ReturnType<typeof getDb>;

/** Ce qu'une ligne de preuve doit porter pour être triée par séquence. */
export interface SequencedProofRow {
  readonly deliverableType: string;
  readonly canonicalKey: string;
  readonly sequenceId: string;
  readonly createdAt: Date | null;
}

/**
 * Ne garde que la dernière séquence de preuve de CHAQUE livrable, dans l'ordre
 * d'entrée.
 *
 * « Dernière » se lit sur `created_at`, et à égalité sur l'ordre d'arrivée des
 * lignes : deux séquences du même livrable écrites dans la même milliseconde
 * n'existent pas en pratique (une preuve dure au moins un spawn), mais le tri
 * doit rester total pour que l'écran ne clignote pas d'un rendu à l'autre.
 *
 * Les livrables sont indépendants : un run qui prouve deux projets garde la
 * dernière séquence de chacun.
 */
export function lastSequencePerDeliverable<T extends SequencedProofRow>(rows: readonly T[]): T[] {
  // clé du livrable → la séquence retenue, et la date qui l'a fait gagner.
  const gagnante = new Map<string, { sequenceId: string; at: number; rang: number }>();
  rows.forEach((row, rang) => {
    const cle = JSON.stringify([row.deliverableType, row.canonicalKey]);
    const at = row.createdAt?.getTime() ?? 0;
    const tenante = gagnante.get(cle);
    if (tenante === undefined || at > tenante.at || (at === tenante.at && rang > tenante.rang)) {
      gagnante.set(cle, { sequenceId: row.sequenceId, at, rang });
    }
  });
  return rows.filter(
    (row) =>
      gagnante.get(JSON.stringify([row.deliverableType, row.canonicalKey]))?.sequenceId ===
      row.sequenceId,
  );
}

/**
 * Combien de tours de réparation chaque job a coûté, par `job_id`.
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
