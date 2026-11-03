// events/publish.ts — les portes où l'état change déposent leur événement (#944).
//
// Chaque fonction ici est appelée par UNE porte, APRÈS que son écriture est
// commise et seulement si c'est elle qui l'a posée (`landed`) : un événement
// dit un fait de la base, jamais une intention qu'une transaction pourrait
// encore défaire, et il n'est dit qu'une fois. Les portes :
//
//   job.finished / job.failed   `finalizeJobSuccess` et `finalizeJobFailure`
//                               (après leur transaction), `failJob` (hors
//                               transaction), `cancelRootJob` — job/state.ts,
//                               job/finalize.ts ;
//   approval.requested /        `notifyApprovalCreated`, le passage obligé de
//   question.asked              toute demande posée : la porte d'approbation et
//                               `ask_user` (packages/tools) comme la question
//                               d'un serveur MCP (approvals/elicitation.ts) ;
//   approval.resolved           `resolveApprovalDecision` (tableau de bord,
//                               cartes de canal, API), la fermeture d'une
//                               question MCP sans réponse, l'expiration.
//
// Le texte est RELU sur la ligne, puis masqué de ses secrets (SECRET-001) ICI,
// une fois, pour tout client : le tableau de bord et un module externe
// reçoivent la même chose.
//
// Une publication ne fait jamais échouer la porte qui l'appelle : le job est
// fini, l'approbation est posée, quoi qu'il arrive à l'événement. Mais une
// publication qui échoue ne se tait pas non plus : elle le dit au journal, et
// elle le dit aux clients par un `resync` (invariant #4).

import { eq, inArray, agentJobs, approvalRequests } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import {
  readElicitationToolInput,
  readQuestionToolInput,
  readStatedPurpose,
  redactSecretsInText,
} from '@nodal-agents/shared';
import type { ApprovalGateRequest } from '@nodal-agents/tools';
import { jobEvents, type ApprovalRequestKind, type JobEventBus } from './job-events.ts';

/** La longueur d'une raison d'échec dans l'événement : une ligne, pas le texte. */
export const JOB_FAILED_REASON_MAX = 300;

function oneLine(text: string): string {
  const first =
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l !== '') ?? '';
  return first.length > JOB_FAILED_REASON_MAX
    ? `${first.slice(0, JOB_FAILED_REASON_MAX - 1)}…`
    : first;
}

function lost(bus: JobEventBus, what: string, err: unknown): void {
  console.error(
    `[job-events] ${what} could not be published; every workspace is told to re-read: ` +
      (err instanceof Error ? err.message : String(err)),
  );
  bus.resyncEverywhere('event_lost');
}

/**
 * Un job vient de poser son statut terminal : `job.finished` (completed,
 * cancelled) ou `job.failed`. Le statut est RELU sur la ligne, pas passé par
 * l'appelant : l'événement dit ce que la base dit.
 */
export async function publishJobEnded(
  db: AnyDrizzleDb,
  jobId: string,
  bus: JobEventBus = jobEvents,
): Promise<void> {
  try {
    const [row] = await db
      .select({
        entityId: agentJobs.entityId,
        conversationId: agentJobs.conversationId,
        parentJobId: agentJobs.parentJobId,
        status: agentJobs.status,
        result: agentJobs.result,
        error: agentJobs.error,
      })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId))
      .limit(1);
    if (!row) throw new Error(`job ${jobId} not found`);
    // Un job sans espace n'a aucun client qui puisse l'écouter.
    if (row.entityId === null) {
      console.warn(`[job-events] job ${jobId} ended without a workspace: no client to tell`);
      return;
    }
    const base = {
      jobId,
      conversationId: row.conversationId,
      parentJobId: row.parentJobId,
    };
    if (row.status === 'completed' || row.status === 'cancelled') {
      bus.publish(row.entityId, row.conversationId, {
        type: 'job.finished',
        ...base,
        status: row.status,
        reply: redactSecretsInText(row.result ?? ''),
      });
      return;
    }
    if (row.status === 'failed') {
      bus.publish(row.entityId, row.conversationId, {
        type: 'job.failed',
        ...base,
        error: row.error ?? '',
        reason: oneLine(redactSecretsInText(row.result ?? '')),
      });
      return;
    }
    // Une porte terminale qui publie un job encore vivant : une erreur de câblage.
    throw new Error(`job ${jobId} is ${String(row.status)}, not terminal`);
  } catch (err) {
    lost(bus, `the end of job ${jobId}`, err);
  }
}

/** Le texte que l'agent (ou le serveur) a écrit sur la demande, et ses options. */
function requestWords(
  kind: ApprovalRequestKind,
  toolInput: unknown,
): { text: string; options: string[] } {
  if (kind === 'question') {
    const q = readQuestionToolInput(toolInput);
    return { text: q?.question ?? '', options: q?.options ?? [] };
  }
  if (kind === 'elicitation') {
    return { text: readElicitationToolInput(toolInput)?.message ?? '', options: [] };
  }
  return { text: readStatedPurpose(toolInput) ?? '', options: [] };
}

/**
 * Une demande vient d'être posée : `approval.requested` pour une approbation,
 * `question.asked` pour une question d'agent ou d'un serveur MCP.
 */
export async function publishApprovalRequested(
  db: AnyDrizzleDb,
  req: ApprovalGateRequest,
  bus: JobEventBus = jobEvents,
): Promise<void> {
  try {
    const [job] = await db
      .select({ conversationId: agentJobs.conversationId })
      .from(agentJobs)
      .where(eq(agentJobs.id, req.jobId))
      .limit(1);
    if (!job) throw new Error(`job ${req.jobId} not found`);
    const words = requestWords(req.kind, req.toolInput);
    const base = {
      approvalId: req.approvalRequestId,
      jobId: req.jobId,
      conversationId: job.conversationId,
      text: redactSecretsInText(words.text),
    };
    if (req.kind === 'approval') {
      bus.publish(req.entityId, job.conversationId, {
        type: 'approval.requested',
        ...base,
        kind: 'approval',
        toolName: req.toolName,
      });
    } else {
      bus.publish(req.entityId, job.conversationId, {
        type: 'question.asked',
        ...base,
        kind: req.kind,
        options: words.options.map(redactSecretsInText),
      });
    }
  } catch (err) {
    lost(bus, `the request ${req.approvalRequestId}`, err);
  }
}

function approvalKind(raw: string): ApprovalRequestKind {
  return raw === 'question' || raw === 'elicitation' ? raw : 'approval';
}

/**
 * Des demandes viennent d'être tranchées (approuvées, refusées, expirées) :
 * un `approval.resolved` chacune, pour qu'un second client ferme sa carte.
 */
export async function publishApprovalsResolved(
  db: AnyDrizzleDb,
  approvalIds: readonly string[],
  bus: JobEventBus = jobEvents,
): Promise<void> {
  if (approvalIds.length === 0) return;
  try {
    const rows = await db
      .select({
        id: approvalRequests.id,
        entityId: approvalRequests.entityId,
        jobId: approvalRequests.jobId,
        kind: approvalRequests.kind,
        status: approvalRequests.status,
        conversationId: agentJobs.conversationId,
      })
      .from(approvalRequests)
      .leftJoin(agentJobs, eq(agentJobs.id, approvalRequests.jobId))
      .where(inArray(approvalRequests.id, [...approvalIds]));
    const missing = approvalIds.filter((id) => !rows.some((r) => r.id === id));
    for (const row of rows) {
      if (row.entityId === null) {
        console.warn(`[job-events] request ${row.id} has no workspace: no client to tell`);
        continue;
      }
      bus.publish(row.entityId, row.conversationId ?? null, {
        type: 'approval.resolved',
        approvalId: row.id,
        jobId: row.jobId,
        conversationId: row.conversationId ?? null,
        kind: approvalKind(row.kind),
        status: row.status ?? '',
      });
    }
    if (missing.length > 0) throw new Error(`requests not found: ${missing.join(', ')}`);
  } catch (err) {
    lost(bus, `the resolution of ${approvalIds.join(', ')}`, err);
  }
}
