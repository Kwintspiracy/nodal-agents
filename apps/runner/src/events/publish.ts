// events/publish.ts — ce que le runner pousse quand l'état change (#944).
//
// Deux transitions ne sont jamais publiées d'ici directement : la fin d'un job
// (`job.finished`, `job.failed`) et une demande tranchée ou expirée
// (`approval.resolved`). Leurs écritures sont des PORTES qui les ANNONCENT
// (`announceTransitions`, packages/db/src/repos/transitions.ts) ; l'annonce
// est remise à l'écouteur de ce processus — `runnerTransitionListener`, branché
// par `createApp` — après le COMMIT de la transaction qui la porte, et
// seulement pour les lignes que la garde de la porte a laissées passer. Les
// portes :
//
//   (a) un job atteint un statut terminal   `completeJob`, `failJob`,
//       `cancelRootJob` (job/state.ts) ; `cancelJobs` (packages/db), par
//       lequel passent l'arrêt d'un arbre (`cancelJobTree` : bouton Stop,
//       outil `stop_conversation_run`, commande `/stop` d'un canal), la
//       cascade d'un enfant annulé vers son parent, l'enfant d'une délégation
//       avortée et le job né pendant un Stop ;
//   (b) une demande quitte `pending`       `decidePendingRequest` (approuvée
//       ou refusée, `resolveApprovalDecision`) et `expirePendingRequests`
//       (arrêt d'un arbre, échéance, question MCP close) — packages/db.
//
// Le test d'architecture du runner refuse une telle écriture hors des portes.
//
// La création d'une demande, elle, n'est pas une transition d'état : elle est
// publiée par `notifyApprovalCreated`, le passage obligé de toute demande
// posée (approbation, `ask_user`, question d'un serveur MCP), une fois la ligne
// commise.
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
import type { AnyDrizzleDb, TransitionListener } from '@nodal-agents/db';
import {
  readElicitationToolInput,
  readQuestionToolInput,
  readStatedPurpose,
  redactSecretsInText,
  type ReplyRendering,
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
 * Un job fini, tel que sa ligne le dit au moment où son `job.finished` part :
 * ce qu'un geste de plus (la réponse dite, #967) lit sans relire la base.
 */
export interface FinishedJob {
  jobId: string;
  entityId: string;
  conversationId: string | null;
  parentJobId: string | null;
  status: 'completed' | 'cancelled';
  /** `agent_jobs.result`, tel qu'en base. */
  result: string | null;
  replyRendering: ReplyRendering;
}

/**
 * Un job vient de poser son statut terminal : `job.finished` (completed,
 * cancelled) ou `job.failed`. Le statut est RELU sur la ligne, pas passé par
 * l'appelant : l'événement dit ce que la base dit.
 *
 * Rend le job quand un `job.finished` est parti, `null` sinon (un échec, une
 * lecture en échec, un job sans espace).
 */
export async function publishJobEnded(
  db: AnyDrizzleDb,
  jobId: string,
  bus: JobEventBus = jobEvents,
): Promise<FinishedJob | null> {
  try {
    const [row] = await db
      .select({
        entityId: agentJobs.entityId,
        conversationId: agentJobs.conversationId,
        parentJobId: agentJobs.parentJobId,
        status: agentJobs.status,
        result: agentJobs.result,
        error: agentJobs.error,
        replyRendering: agentJobs.replyRendering,
      })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId))
      .limit(1);
    if (!row) throw new Error(`job ${jobId} not found`);
    // Un job sans espace n'a aucun client qui puisse l'écouter.
    if (row.entityId === null) {
      console.warn(`[job-events] job ${jobId} ended without a workspace: no client to tell`);
      return null;
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
      return {
        ...base,
        entityId: row.entityId,
        status: row.status,
        result: row.result,
        replyRendering: row.replyRendering,
      };
    }
    if (row.status === 'failed') {
      bus.publish(row.entityId, row.conversationId, {
        type: 'job.failed',
        ...base,
        error: row.error ?? '',
        reason: oneLine(redactSecretsInText(row.result ?? '')),
      });
      return null;
    }
    // Une porte terminale qui publie un job encore vivant : une erreur de câblage.
    throw new Error(`job ${jobId} is ${String(row.status)}, not terminal`);
  } catch (err) {
    lost(bus, `the end of job ${jobId}`, err);
    return null;
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

/**
 * L'écouteur des transitions de ce processus : ce que les portes ont annoncé,
 * une fois COMMIS, devient les événements du flux. `lost` (une annonce faite
 * dans une transaction dont le COMMIT ne peut pas être suivi) dit à chaque
 * espace de relire la base.
 *
 * `onFinished` : ce qui suit un `job.finished`, juste après lui, sur le même
 * bus — la réponse dite d'un job lancé par la voix (#967,
 * chat/job-reply-voice.ts, branchée par `createApp`). Il ne doit rien attendre :
 * l'écouteur publie les fins une par une.
 */
export function transitionListener(
  bus: JobEventBus = jobEvents,
  onFinished?: (db: AnyDrizzleDb, job: FinishedJob) => void,
): TransitionListener {
  return {
    committed: async (db, t) => {
      for (const jobId of t.endedJobIds) {
        const finished = await publishJobEnded(db, jobId, bus);
        if (finished && onFinished) onFinished(db, finished);
      }
      await publishApprovalsResolved(db, t.settledRequestIds, bus);
    },
    lost: () => bus.resyncEverywhere('event_lost'),
  };
}
