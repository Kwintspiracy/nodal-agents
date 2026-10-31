// repos/run-state.ts — OÙ EN EST un run, lu sur tout son arbre (#887).
//
// Le statut d'une ligne `agent_jobs` ne dit pas si le travail est fini : une
// tête peut être terminée alors qu'un délégué court encore, et la tête que sa
// file a fait naître (#531) continue le même travail. Un run est fini quand
// AUCUN job de son arbre (`descendRunTree`, le même ensemble que l'arrêt et le
// budget de run) ne vit encore — la même règle que le banc des workflows
// (`liveJobs`) et que les runs vivants d'une conversation (`liveJob`).
//
// Une lecture, jamais une écriture : rien ici ne verrouille ni ne réclame.

import { and, asc, eq, inArray } from 'drizzle-orm';
import { isTerminalJobStatus } from '@nodal-agents/shared';
import type { AnyDrizzleDb } from '../client.ts';
import { agentJobs } from '../schema/jobs.ts';
import { approvalRequests, approvalsOldestFirst } from '../schema/approvals.ts';
import { jobDeliverableVerificationState } from '../schema/verification.ts';
import { descendRunTree } from './run-tree.ts';

/** Ce qu'un run fait maintenant, tout son arbre lu. */
export type RunStatus = 'running' | 'waiting_for_person' | 'completed' | 'failed' | 'cancelled';

/** Une demande qui attend une personne : une approbation, une question, ou le formulaire d'un serveur MCP. */
export interface RunPendingRequest {
  readonly requestId: string;
  readonly jobId: string;
  /** `approval`, `question` ou `elicitation` (approval_requests.kind). */
  readonly kind: string;
  readonly toolName: string;
  /** Ce que la demande porte, tel qu'écrit par l'outil ou le serveur : la question, les options, le formulaire. */
  readonly toolInput: unknown;
  readonly requestedAt: string | null;
}

/** Un livrable qu'un job du run a visé (l'écran ne montre que ceux-là : `addressed`). */
export interface RunDeliverable {
  readonly jobId: string;
  readonly path: string;
  readonly type: string;
  /** L'agent l'a nommé dans `return_result.deliverables` (#509). */
  readonly declared: boolean;
  /** L'état de sa preuve (decision_status). */
  readonly verification: string;
}

export interface RunState {
  readonly headJobId: string;
  /** Le statut de la ligne de tête, tel qu'en base : il peut être terminal alors que le run court encore. */
  readonly headStatus: string | null;
  readonly status: RunStatus;
  readonly result: string | null;
  readonly error: string | null;
  /** Les jobs de l'arbre qui ne sont pas terminés, la tête comprise quand elle vit. */
  readonly liveJobIds: readonly string[];
  readonly pendingRequests: readonly RunPendingRequest[];
  readonly deliverables: readonly RunDeliverable[];
}

/** Un statut NULL n'a pas fini non plus (même lecture que le banc, `isLive`). */
function isLive(status: string | null): boolean {
  return status === null || !isTerminalJobStatus(status);
}

/**
 * L'état du run dont `headJobId` est la tête, dans l'espace `entityId`.
 * Rend null quand la tête n'est pas un job de cet espace : l'appelant dit
 * lui-même ce que vaut une absence.
 *
 * Le statut :
 *   - un job de l'arbre vit encore, et une demande d'un job VIVANT attend une
 *     personne ⇒ `waiting_for_person` ;
 *   - un job de l'arbre vit encore ⇒ `running` ;
 *   - plus rien ne vit ⇒ le statut terminal de la tête.
 */
export async function readRunState(
  db: AnyDrizzleDb,
  entityId: string,
  headJobId: string,
): Promise<RunState | null> {
  const [head] = await db
    .select({ status: agentJobs.status, result: agentJobs.result, error: agentJobs.error })
    .from(agentJobs)
    .where(and(eq(agentJobs.id, headJobId), eq(agentJobs.entityId, entityId)))
    .limit(1);
  if (!head) return null;

  const treeIds = await descendRunTree(db, entityId, [headJobId]);
  const tree = await db
    .select({ id: agentJobs.id, status: agentJobs.status })
    .from(agentJobs)
    .where(and(eq(agentJobs.entityId, entityId), inArray(agentJobs.id, treeIds)));
  const liveJobIds = tree.filter((j) => isLive(j.status)).map((j) => j.id);

  const pending =
    liveJobIds.length === 0
      ? []
      : await db
          .select({
            requestId: approvalRequests.id,
            jobId: approvalRequests.jobId,
            kind: approvalRequests.kind,
            toolName: approvalRequests.toolName,
            toolInput: approvalRequests.toolInput,
            requestedAt: approvalRequests.requestedAt,
          })
          .from(approvalRequests)
          .where(
            and(
              eq(approvalRequests.entityId, entityId),
              inArray(approvalRequests.jobId, liveJobIds),
              eq(approvalRequests.status, 'pending'),
            ),
          )
          .orderBy(approvalsOldestFirst);

  const deliverables = await db
    .select({
      jobId: jobDeliverableVerificationState.jobId,
      canonicalKey: jobDeliverableVerificationState.canonicalKey,
      displayPath: jobDeliverableVerificationState.displayPathSnapshot,
      type: jobDeliverableVerificationState.deliverableType,
      declared: jobDeliverableVerificationState.declared,
      verification: jobDeliverableVerificationState.decisionStatus,
    })
    .from(jobDeliverableVerificationState)
    .where(
      and(
        inArray(jobDeliverableVerificationState.jobId, treeIds),
        eq(jobDeliverableVerificationState.addressed, true),
      ),
    )
    .orderBy(
      asc(jobDeliverableVerificationState.updatedAt),
      asc(jobDeliverableVerificationState.id),
    );

  const status: RunStatus =
    liveJobIds.length > 0
      ? pending.length > 0
        ? 'waiting_for_person'
        : 'running'
      : (head.status as 'completed' | 'failed' | 'cancelled');

  return {
    headJobId,
    headStatus: head.status,
    status,
    result: head.result,
    error: head.error,
    liveJobIds,
    pendingRequests: pending.map((r) => ({
      ...r,
      requestedAt: r.requestedAt ? r.requestedAt.toISOString() : null,
    })),
    deliverables: deliverables.map((d) => ({
      jobId: d.jobId,
      path: d.displayPath ?? d.canonicalKey,
      type: d.type,
      declared: d.declared,
      verification: d.verification,
    })),
  };
}
