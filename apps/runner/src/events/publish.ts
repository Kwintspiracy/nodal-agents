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

import {
  eq,
  inArray,
  agentJobs,
  approvalRequests,
  readRunState,
  runOriginOf,
} from '@nodal-agents/db';
import type { AnyDrizzleDb, RunState, RunStatus, TransitionListener } from '@nodal-agents/db';
import {
  DeviceEventSchema,
  type DeviceEvent,
  type DeviceRunState,
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

/**
 * L'appareil d'un chat (#945) : le chat lui-même, quand il a été résolu sur le
 * canal `device` (`designateChat`) ; null sinon.
 */
export function deviceOfChat(chat: {
  chatId: string | null;
  chatChannel: string | null;
}): string | null {
  return chat.chatChannel === 'device' && chat.chatId ? chat.chatId : null;
}

/** D'où vient la demande d'un job : la tête de son run, et son appareil s'il en a un. */
interface JobOrigin {
  headJobId: string;
  deviceId: string | null;
}

/**
 * L'appareil d'où vient la demande d'un job : celui du chat de la TÊTE de son
 * run (`runOriginOf`, @nodal-agents/db) — la même lecture que l'envoi d'une
 * carte (approvals/notify.ts) et que la liste des cartes (routes/devices.ts).
 * Un délégué, un enfant du tableau des tâches, une tête relancée : tous
 * reviennent à l'appareil de la demande.
 */
async function originOfJob(
  db: AnyDrizzleDb,
  entityId: string | null,
  jobId: string,
): Promise<JobOrigin> {
  if (!entityId) return { headJobId: jobId, deviceId: null };
  const origin = await runOriginOf(db, entityId, jobId);
  return {
    headJobId: origin?.headJobId ?? jobId,
    deviceId: origin ? deviceOfChat(origin) : null,
  };
}

function lost(bus: JobEventBus, what: string, err: unknown): void {
  console.error(
    `[job-events] ${what} could not be published; every workspace is told to re-read: ` +
      (err instanceof Error ? err.message : String(err)),
  );
  bus.resyncEverywhere('event_lost');
}

// ─── L'état du run, POUSSÉ à l'appareil d'où vient la demande (#945) ──────────
//
// Un client externe qui confie un travail suivait son run en relisant
// `get_task` en boucle, jusqu'à trente minutes. L'appareil reçoit la MÊME
// lecture (`readRunState`, @nodal-agents/db — celle de `get_task`), poussée à
// chaque transition du run : un job pris (`claimJob`, execute.ts), une demande
// posée ou tranchée, un job fini. Sur la tête du run (`runOriginOf`) : le job
// que la demande a lancé, quel que soit le délégué qui a bougé. Les livrables
// sont ceux que `get_task` rend, des chemins — jamais lus dans le texte de
// l'agent.
//
// L'ORDRE EST PROUVÉ (revue Reviewer A de #1005, passe 2). Deux transitions
// d'un même run, poussées ensemble, liraient chacune la base et publieraient
// dans l'ordre où leurs lectures reviennent : une lecture plus ancienne
// pouvait partir en dernier, et l'appareil finir sur `waiting` après `done`.
// Les poussées d'un run sont donc SÉRIALISÉES (`runPushes`) : chacune lit la
// base après que la précédente a publié, si bien que la dernière publiée est
// la lecture la plus récente — le serveur ne publie jamais une lecture plus
// ancienne que la dernière. Et chaque `state` porte `seq`, le numéro de son
// événement dans l'espace : croissant, de quoi comparer côté client.

const DEVICE_RUN_STATE = {
  running: 'working',
  waiting_for_person: 'waiting',
  completed: 'done',
  cancelled: 'cancelled',
  failed: 'failed',
} as const satisfies Record<RunStatus, DeviceRunState>;

/** Le geste `state` d'un run, tel que sa lecture le dit. */
export function runStateEvent(
  conversationId: string | null,
  state: RunState,
): Omit<Extract<DeviceEvent, { type: 'state' }>, 'seq'> {
  const reason = state.status === 'failed' ? oneLine(redactSecretsInText(state.result ?? '')) : '';
  return {
    type: 'state',
    jobId: state.headJobId,
    conversationId,
    state: DEVICE_RUN_STATE[state.status],
    waitingFor: state.pendingRequests.map((r) => r.requestId),
    deliverables: state.deliverables.map((d) => ({
      path: d.path,
      type: d.type,
      declared: d.declared,
      verification: d.verification,
    })),
    ...(reason ? { reason } : {}),
  };
}

/** Le run, réduit à ce qui dit où pousser son état. */
interface RunRef {
  entityId: string | null;
  conversationId: string | null;
  origin: JobOrigin;
}

/** La poussée en cours (ou la dernière) de chaque run, par `<espace>:<tête>`. */
const runPushes = new Map<string, Promise<void>>();

/** Lit le run et publie son état, maintenant. Ne lève jamais : un échec est dit. */
async function readAndPublishRunState(
  db: AnyDrizzleDb,
  entityId: string,
  run: RunRef,
  deviceId: string,
  bus: JobEventBus,
): Promise<void> {
  const head = run.origin.headJobId;
  try {
    const state = await readRunState(db, entityId, head);
    if (!state) throw new Error(`run head ${head} not found`);
    const event = runStateEvent(run.conversationId, state);
    bus.publish(
      entityId,
      run.conversationId,
      (seq) => ({ type: 'device.event', event: DeviceEventSchema.parse({ ...event, seq }) }),
      deviceId,
    );
  } catch (err) {
    lost(bus, `the run state of ${head}`, err);
  }
}

/**
 * Pousse l'état du run à l'appareil d'où vient sa demande — APRÈS toute
 * poussée de ce run encore en cours (l'ordre prouvé, ci-dessus).
 */
function pushRunState(db: AnyDrizzleDb, run: RunRef, bus: JobEventBus): Promise<void> {
  const { entityId } = run;
  const deviceId = run.origin.deviceId;
  if (!deviceId || !entityId) return Promise.resolve();
  const key = `${entityId}:${run.origin.headJobId}`;
  const previous = runPushes.get(key) ?? Promise.resolve();
  const next = previous.then(() => readAndPublishRunState(db, entityId, run, deviceId, bus));
  runPushes.set(key, next);
  void next.then(() => {
    if (runPushes.get(key) === next) runPushes.delete(key);
  });
  return next;
}

/**
 * Un job vient d'être PRIS (`claimJob`) : son run travaille. Poussé à
 * l'appareil d'où vient la demande, et à personne d'autre ; rien pour un job
 * qui n'en vient pas. Ne fait jamais échouer la prise.
 */
export async function publishJobClaimed(
  db: AnyDrizzleDb,
  jobId: string,
  bus: JobEventBus = jobEvents,
): Promise<void> {
  try {
    const [row] = await db
      .select({ entityId: agentJobs.entityId, conversationId: agentJobs.conversationId })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId))
      .limit(1);
    if (!row) throw new Error(`job ${jobId} not found`);
    await pushRunState(
      db,
      {
        entityId: row.entityId,
        conversationId: row.conversationId,
        origin: await originOfJob(db, row.entityId, jobId),
      },
      bus,
    );
  } catch (err) {
    lost(bus, `the claim of job ${jobId}`, err);
  }
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
  /** L'appareil d'où vient la demande (#945), ou null. */
  deviceId: string | null;
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
    const origin = await originOfJob(db, row.entityId, jobId);
    const deviceId = origin.deviceId;
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
      bus.publish(
        row.entityId,
        row.conversationId,
        {
          type: 'job.finished',
          ...base,
          status: row.status,
          reply: redactSecretsInText(row.result ?? ''),
        },
        deviceId,
      );
      await pushRunState(
        db,
        { entityId: row.entityId, conversationId: row.conversationId, origin },
        bus,
      );
      return {
        ...base,
        entityId: row.entityId,
        status: row.status,
        result: row.result,
        replyRendering: row.replyRendering,
        deviceId,
      };
    }
    if (row.status === 'failed') {
      bus.publish(
        row.entityId,
        row.conversationId,
        {
          type: 'job.failed',
          ...base,
          error: row.error ?? '',
          reason: oneLine(redactSecretsInText(row.result ?? '')),
        },
        deviceId,
      );
      await pushRunState(
        db,
        { entityId: row.entityId, conversationId: row.conversationId, origin },
        bus,
      );
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
    const origin = await originOfJob(db, req.entityId, req.jobId);
    const deviceId = origin.deviceId;
    const words = requestWords(req.kind, req.toolInput);
    const base = {
      approvalId: req.approvalRequestId,
      jobId: req.jobId,
      conversationId: job.conversationId,
      text: redactSecretsInText(words.text),
    };
    if (req.kind === 'approval') {
      bus.publish(
        req.entityId,
        job.conversationId,
        { type: 'approval.requested', ...base, kind: 'approval', toolName: req.toolName },
        deviceId,
      );
    } else {
      bus.publish(
        req.entityId,
        job.conversationId,
        {
          type: 'question.asked',
          ...base,
          kind: req.kind,
          options: words.options.map(redactSecretsInText),
        },
        deviceId,
      );
    }
    await pushRunState(
      db,
      { entityId: req.entityId, conversationId: job.conversationId, origin },
      bus,
    );
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
      const origin = await originOfJob(db, row.entityId, row.jobId);
      const deviceId = origin.deviceId;
      bus.publish(
        row.entityId,
        row.conversationId ?? null,
        {
          type: 'approval.resolved',
          approvalId: row.id,
          jobId: row.jobId,
          conversationId: row.conversationId ?? null,
          kind: approvalKind(row.kind),
          status: row.status ?? '',
        },
        deviceId,
      );
      await pushRunState(
        db,
        { entityId: row.entityId, conversationId: row.conversationId ?? null, origin },
        bus,
      );
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
