// job/approval-execution.ts — une approbation s'exécute UNE fois, sous la prise du run qui la tient (#566).
//
// CE QUI S'EST PASSÉ (revue Codex de #575, passe 3). Un run rejouait un outil
// APPROUVÉ après avoir vérifié son droit d'agir, puis posait `executed_at`
// sans condition. Repris entre-temps par un autre run (le faucheur l'avait
// remis en file), le job voyait deux exécutions possibles et une perte : le
// premier run tamponnait la demande, son point de reprise était refusé (il
// n'avait plus la prise), et le second, voyant la demande « exécutée »,
// sautait l'appel — le résultat n'était nulle part. Si le second avait lu la
// demande avant le tampon, les deux l'exécutaient : l'effet approuvé UNE fois
// avait lieu deux fois.
//
// LA FORME GÉNÉRALE.
//   1. RÉSERVER avant d'exécuter : `execution_claim` = la prise du run, posée
//      atomiquement sur une demande ni exécutée ni réservée, et seulement si
//      le job est `processing` sous cette prise.
//   2. CONSIGNER la fin sous la réservation : `executed_at` + `execution_output`
//      (le tool_result). Même si le job a été repris entre-temps : l'effet a eu
//      lieu, le run suivant REPREND ce résultat au lieu de le perdre.
//   3. Une réservation d'une prise PLUS ANCIENNE, jamais consignée : le run
//      qui l'a posée a été remplacé en pleine exécution. L'effet a peut-être eu
//      lieu ; le rejouer le doublerait. Le run courant ne l'exécute pas : il
//      clôt la demande avec un résultat qui le DIT au modèle
//      (`APPROVED_CALL_OUTCOME_UNKNOWN`), qui vérifie avant de redemander.
//      Aucune perte silencieuse, aucun doublon.

import { and, eq, isNull, sql, agentJobs, approvalRequests } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';

/**
 * Le tool_result d'un appel approuvé qu'un run précédent a commencé sans en
 * consigner la fin (#566). Un texte de HARNAIS pour le modèle, jamais montré
 * à la personne.
 */
export const APPROVED_CALL_OUTCOME_UNKNOWN =
  'approved_call_outcome_unknown: a previous run of this job started this approved call and ' +
  'was replaced before it recorded the result. It may or may not have taken effect: check ' +
  'its effect before calling it again (a new call may ask for approval again).';

/** Ce qu'un run trouve en voulant exécuter une demande approuvée. */
export type ApprovedExecution =
  /** À ce run d'exécuter : la demande est réservée sous sa prise. */
  | { kind: 'reserved' }
  /** Déjà close et consignée : son résultat est à reprendre tel quel (null : inconnu). */
  | { kind: 'recorded'; output: unknown }
  /** Commencée par un run remplacé depuis, fin jamais consignée. */
  | { kind: 'started_elsewhere'; claim: number }
  /** Le job n'est plus à ce run : il ne réserve rien. */
  | { kind: 'job_lost' };

/** Le job est `processing` sous CETTE prise — la condition de toute réservation. */
function jobTenuSous(jobId: string, prise: number) {
  return sql`exists (select 1 from ${agentJobs} where ${agentJobs.id} = ${jobId} and ${agentJobs.status} = 'processing' and ${agentJobs.claimGeneration} = ${prise})`;
}

/** Réserve l'exécution de la demande `requestId` pour le run qui tient `prise`. */
export async function reserveApprovedExecution(
  db: AnyDrizzleDb,
  requestId: string,
  jobId: string,
  prise: number,
): Promise<ApprovedExecution> {
  const reserve = await db
    .update(approvalRequests)
    .set({ executionClaim: prise })
    .where(
      and(
        eq(approvalRequests.id, requestId),
        isNull(approvalRequests.executedAt),
        isNull(approvalRequests.executionClaim),
        jobTenuSous(jobId, prise),
      ),
    )
    .returning({ id: approvalRequests.id });
  if (reserve.length > 0) return { kind: 'reserved' };

  const [ligne] = await db
    .select({
      executedAt: approvalRequests.executedAt,
      executionClaim: approvalRequests.executionClaim,
      executionOutput: approvalRequests.executionOutput,
    })
    .from(approvalRequests)
    .where(eq(approvalRequests.id, requestId))
    .limit(1);
  if (!ligne) return { kind: 'job_lost' };
  // Close ailleurs : son résultat est consigné (NULL seulement pour une
  // demande close avant cette colonne — l'issue n'en est alors pas connue).
  if (ligne.executedAt !== null) return { kind: 'recorded', output: ligne.executionOutput };
  // Réservée par une prise plus ancienne, jamais consignée.
  if (ligne.executionClaim !== null && ligne.executionClaim < prise) {
    return { kind: 'started_elsewhere', claim: ligne.executionClaim };
  }
  // Libre mais refusée : le job n'est plus sous cette prise (ou une prise
  // plus récente l'a réservée).
  return { kind: 'job_lost' };
}

/**
 * Consigne la fin d'une exécution réservée : sous la RÉSERVATION seulement —
 * l'effet a eu lieu, qu'importe que le job ait été repris depuis. Rend false
 * quand la demande a été close par un autre run (qui l'a dite au modèle).
 */
export async function recordApprovedExecution(
  db: AnyDrizzleDb,
  requestId: string,
  prise: number,
  output: unknown,
): Promise<boolean> {
  const rows = await db
    .update(approvalRequests)
    .set({ executedAt: new Date(), executionOutput: output })
    .where(
      and(
        eq(approvalRequests.id, requestId),
        eq(approvalRequests.executionClaim, prise),
        isNull(approvalRequests.executedAt),
      ),
    )
    .returning({ id: approvalRequests.id });
  return rows.length > 0;
}

/**
 * Clôt, sous la prise courante du job, une demande qu'un run remplacé avait
 * réservée sans consigner sa fin : `output` dit au modèle que l'issue est
 * inconnue. Rend false si la fin a été consignée entre-temps (le résultat est
 * alors à reprendre) ou si le job n'est plus à ce run.
 */
export async function closeUnknownApprovedExecution(
  db: AnyDrizzleDb,
  requestId: string,
  jobId: string,
  ancienne: number,
  prise: number,
  output: unknown,
): Promise<boolean> {
  const rows = await db
    .update(approvalRequests)
    .set({ executedAt: new Date(), executionOutput: output, executionClaim: prise })
    .where(
      and(
        eq(approvalRequests.id, requestId),
        eq(approvalRequests.executionClaim, ancienne),
        isNull(approvalRequests.executedAt),
        jobTenuSous(jobId, prise),
      ),
    )
    .returning({ id: approvalRequests.id });
  return rows.length > 0;
}

/**
 * Clôt une demande qui n'exécute RIEN (refusée, expirée, ou refusée par le
 * plancher catastrophique) : son résultat est consigné pour qu'un run suivant
 * le reprenne. Idempotent : une demande déjà close garde son résultat.
 */
export async function recordApprovalWithoutEffect(
  db: AnyDrizzleDb,
  requestId: string,
  output: unknown,
): Promise<void> {
  await db
    .update(approvalRequests)
    .set({ executedAt: new Date(), executionOutput: output })
    .where(and(eq(approvalRequests.id, requestId), isNull(approvalRequests.executedAt)));
}
