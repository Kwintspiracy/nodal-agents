// Built-in: list_conversation_runs + stop_conversation_run (#567)
//          + message_conversation_run (#531)
//
// Sur un canal, chaque message lance un NOUVEAU job de tête. Le 28/09, le
// propriétaire a écrit « Arrête !!! » trois fois pendant qu'un ComfyArtist
// délégué tournait : chaque « arrête » était un job neuf, qui a lu `list_tasks`
// — le tableau de SON propre job, vide par construction — et a répondu « rien
// ne tourne ». Aucun outil ne voyait les runs de la conversation, aucun ne
// pouvait les arrêter : seul le bouton Stop du web le pouvait.
//
// Ces deux outils donnent au job de tête d'une conversation, quel que soit le
// canal (Telegram, Discord, Slack, WhatsApp, le web) et quel que soit l'agent,
// la vue de TOUT ce qui tourne dans sa conversation et le même arrêt que le
// bouton Stop (`cancelJobTree`, @nodal-agents/db — un seul chemin).
//
// Ils ne sont PAS toujours disponibles : le runner les offre au job de tête
// d'une conversation (`agent_jobs.conversation_id` posé, `parent_job_id` nul),
// comme il offre `save_routine_state` au seul job d'une routine. Un délégué ne
// les voit pas : ce n'est pas à lui d'arrêter les autres runs de la personne.
//
// Le périmètre lu est dit dans la réponse, et il est complet : jamais un
// « rien » pour un périmètre que l'outil ne lit pas.

import { z } from 'zod';
import {
  agentJobs,
  agents,
  and,
  deliverToConversationJob,
  eq,
  inArray,
  listConversationRuns,
  stopConversationRuns,
  stopRuns,
} from '@nodal-agents/db';
import type { AnyDrizzleDb, ConversationRun, StoppedRuns } from '@nodal-agents/db';
import type { ToolDefinition } from '../types';

/** Au-delà, la consigne d'un job est coupée : le modèle en a besoin pour reconnaître le run. */
const TASK_PREVIEW_MAX = 200;

/** Ce que les deux outils lisent, dit au modèle avec la réponse. */
const SCOPE =
  'every run started in this conversation by any earlier message, with its delegations, ' +
  'its task-board tasks and its pending approvals and questions; your own current run is ' +
  'not listed';

function preview(text: string): string {
  return text.length <= TASK_PREVIEW_MAX ? text : `${text.slice(0, TASK_PREVIEW_MAX)}…`;
}

/**
 * La conversation du job appelant et la tête de son propre run, lues en base.
 * Lève quand le job n'est le tour d'aucune conversation : l'outil n'a alors
 * aucun périmètre, et le dire vaut mieux qu'une liste vide (invariant #4).
 */
async function callerScope(
  db: AnyDrizzleDb,
  entityId: string,
  jobId: string,
): Promise<{ conversationId: string; ownHeadJobId: string }> {
  let cur = jobId;
  let conversationId: string | null = null;
  // Remonte jusqu'à la tête : borné par la profondeur de délégation, et par
  // `seen` sur un graphe corrompu.
  const seen = new Set<string>();
  for (;;) {
    const [row] = await db
      .select({
        parentJobId: agentJobs.parentJobId,
        conversationId: agentJobs.conversationId,
      })
      .from(agentJobs)
      .where(and(eq(agentJobs.id, cur), eq(agentJobs.entityId, entityId)))
      .limit(1);
    if (!row) throw new Error(`conversation_runs_error: job ${cur} not found in this workspace.`);
    conversationId ??= row.conversationId;
    seen.add(cur);
    if (row.parentJobId === null || seen.has(row.parentJobId)) break;
    cur = row.parentJobId;
  }
  if (conversationId === null) {
    throw new Error(
      'conversation_runs_error: this job is not a turn of a conversation (it was started by a ' +
        'schedule, a webhook or the API), so it has no conversation whose runs could be read.',
    );
  }
  return { conversationId, ownHeadJobId: cur };
}

function runView(r: ConversationRun) {
  return {
    run_id: r.headJobId,
    head_status: r.headStatus,
    task: preview(r.headTask),
    started_at: r.startedAt ? r.startedAt.toISOString() : null,
    live_jobs: r.liveJobs.map((j) => ({
      job_id: j.id,
      agent: j.agentSlug,
      status: j.status,
      delegated: j.parentJobId !== null,
      task: preview(j.task),
    })),
    open_tasks: r.openTasks.map((t) => ({
      task_id: t.id,
      title: t.title,
      status: t.status,
      assigned_to: t.assignedTo,
    })),
    pending_requests: r.pendingRequests.map((p) => ({
      request_id: p.id,
      job_id: p.jobId,
      kind: p.kind,
      tool: p.toolName,
      requested_at: p.requestedAt ? p.requestedAt.toISOString() : null,
    })),
  };
}

// ─── Comment un job annulé s'arrête, par runtime (revue Codex de #572, passe 3)
//
// Le texte rendu au modèle doit être VRAI pour le run qu'il vient d'arrêter, et
// un arrêt ne se passe pas pareil partout. Un seul texte pour tous disait « un
// appel en cours finit d'abord » : faux pour Claude Code et Codex, dont le
// processus est tué. Chaque job annulé reçoit donc la phrase de SON runtime, lu
// en base (`agents.runtime`).

/** Ce qui vaut pour tout job annulé, quel que soit son runtime. */
const FOR_EVERY_JOB =
  'A cancelled job never resumes: if it was waiting (pending, awaiting an approval, an answer ' +
  'or a delegate), it will not run again, and its closed approvals and questions can no ' +
  'longer be answered. What it already did (files written, messages sent) stays done.';

/** La phrase de chaque runtime — ce que son code fait réellement à l'arrêt. */
const HOW_A_RUNTIME_STOPS: Readonly<Record<string, string>> = {
  // apps/runner/src/job/execute.ts : le statut est relu avant chaque appel au
  // modèle et pendant l'appel ; les appels d'outils d'une étape déjà lancée ne
  // sont pas interrompus.
  nodal:
    'Stops before its next model call; a model call in progress is interrupted within ' +
    'seconds. Tool calls of the step already under way may still complete.',
  // apps/runner/src/cli-runtime/run-job.ts : la ligne est relue chaque seconde
  // et le processus est tué dès qu'elle ne dit plus `processing`.
  'claude-code':
    'Its Claude Code process is killed within seconds, wherever it is in its work; a turn ' +
    'not yet started never starts.',
  codex:
    'Its Codex process is killed within seconds, wherever it is in its work; a turn not yet ' +
    'started never starts.',
};

async function howEachJobStops(
  db: AnyDrizzleDb,
  jobIds: readonly string[],
): Promise<StopConversationRunOutput['how_each_job_stops']> {
  if (jobIds.length === 0) return [];
  const rows = await db
    .select({ id: agentJobs.id, runtime: agents.runtime })
    .from(agentJobs)
    .leftJoin(agents, eq(agents.id, agentJobs.agentId))
    .where(inArray(agentJobs.id, [...jobIds]));
  const runtimeOf = new Map(rows.map((r) => [r.id, r.runtime ?? 'nodal']));
  return jobIds.map((id) => {
    const runtime = runtimeOf.get(id) ?? 'unknown';
    return {
      job_id: id,
      runtime,
      // Un runtime que cet outil ne décrit pas est DIT tel quel, jamais
      // habillé de la phrase d'un autre (invariant #4).
      how:
        HOW_A_RUNTIME_STOPS[runtime] ??
        `Marked cancelled; how the runtime '${runtime}' reacts to a cancel is not known to this tool.`,
    };
  });
}

// ─── list_conversation_runs ──────────────────────────────────────────────────

export const ListConversationRunsInputSchema = z.object({});

export type ListConversationRunsOutput = {
  scope: string;
  runs: Array<ReturnType<typeof runView>>;
};

export const listConversationRunsTool: ToolDefinition<
  typeof ListConversationRunsInputSchema,
  ListConversationRunsOutput
> = {
  name: 'list_conversation_runs',
  label: 'See what is running in this conversation',
  summary:
    'List the work still running from earlier messages of this conversation, with its delegations and the approvals or questions it is waiting on.',
  description:
    'List the runs STILL IN PROGRESS in this conversation: every run started by an earlier ' +
    'message (on any channel), with each delegated agent still working, its task-board tasks ' +
    'not yet finished, and the approvals and questions it is waiting on. Your own current run ' +
    'is not listed. Call it before stating whether anything is running, and to get the ' +
    '`run_id` that `stop_conversation_run` takes. An empty `runs` means nothing started from ' +
    'this conversation is still running.',
  inputSchema: ListConversationRunsInputSchema,
  riskLevel: 'read',
  card: 'text',
  execute: async (_input, ctx) => {
    const { conversationId, ownHeadJobId } = await callerScope(ctx.db, ctx.entityId, ctx.jobId);
    const runs = await listConversationRuns(ctx.db, {
      entityId: ctx.entityId,
      conversationId,
      excludeHeadJobId: ownHeadJobId,
    });
    return { scope: SCOPE, runs: runs.map(runView) };
  },
};

// ─── stop_conversation_run ───────────────────────────────────────────────────

export const StopConversationRunInputSchema = z.object({
  run_id: z
    .string()
    .uuid()
    .optional()
    .describe(
      'The `run_id` of one run, as `list_conversation_runs` returns it. Omit it to stop EVERY ' +
        'run still in progress in this conversation.',
    ),
});

export type StopConversationRunInput = z.infer<typeof StopConversationRunInputSchema>;

export type StopConversationRunOutput = {
  scope: string;
  stopped: Array<{
    run_id: string;
    cancelled_job_ids: string[];
    cancelled_task_ids: string[];
    closed_request_ids: string[];
  }>;
  /** Les runs visés où rien ne vivait plus : rien n'y a été changé. */
  already_finished: string[];
  /** Comment CHAQUE job annulé s'arrête : cela dépend du runtime qui le sert. */
  how_each_job_stops: Array<{ job_id: string; runtime: string; how: string }>;
  /** Ce qui vaut pour tous, quel que soit le runtime. */
  for_every_job: string;
};

export const stopConversationRunTool: ToolDefinition<
  typeof StopConversationRunInputSchema,
  StopConversationRunOutput
> = {
  name: 'stop_conversation_run',
  label: 'Stop work running in this conversation',
  summary:
    'Stop a run started from an earlier message of this conversation, or all of them, with its delegations. Its pending approvals and questions are closed. Same effect as the Stop button.',
  description:
    'Stop a run still in progress in this conversation, the same way the Stop button of the ' +
    'dashboard does: the run and every agent it delegated to are cancelled, its unfinished ' +
    'task-board tasks are cancelled, and its pending approvals and questions are closed. Pass ' +
    'the `run_id` from `list_conversation_runs`, or omit it to stop every run of this ' +
    'conversation. Use it when the person asks to stop, cancel or abort work. Your own current ' +
    'run is never stopped by this tool.',
  inputSchema: StopConversationRunInputSchema,
  riskLevel: 'write',
  card: 'text',
  execute: async (input, ctx) => {
    const { conversationId, ownHeadJobId } = await callerScope(ctx.db, ctx.entityId, ctx.jobId);

    let result: StoppedRuns;
    if (input.run_id !== undefined) {
      if (input.run_id === ownHeadJobId) {
        throw new Error(
          'conversation_runs_error: that run_id is your own current run. To stop it, finish ' +
            'your turn with return_result.',
        );
      }
      // Une tête de CETTE conversation, dans cet espace : un run d'une autre
      // conversation n'est ni lisible ni arrêtable d'ici.
      const [head] = await ctx.db
        .select({ id: agentJobs.id, parentJobId: agentJobs.parentJobId })
        .from(agentJobs)
        .where(
          and(
            eq(agentJobs.id, input.run_id),
            eq(agentJobs.entityId, ctx.entityId),
            eq(agentJobs.conversationId, conversationId),
          ),
        )
        .limit(1);
      if (!head || head.parentJobId !== null) {
        throw new Error(
          `conversation_runs_error: ${input.run_id} is not a run of this conversation. Use a ` +
            '`run_id` returned by list_conversation_runs.',
        );
      }
      result = await stopRuns(ctx.db, { entityId: ctx.entityId, runIds: [head.id] });
    } else {
      // La même définition que la commande `/stop` d'un canal (#602).
      result = await stopConversationRuns(ctx.db, {
        entityId: ctx.entityId,
        conversationId,
        excludeHeadJobId: ownHeadJobId,
      });
    }

    const stopped: StopConversationRunOutput['stopped'] = result.stopped.map((r) => ({
      run_id: r.runId,
      cancelled_job_ids: r.jobIds,
      cancelled_task_ids: r.taskIds,
      closed_request_ids: r.requestIds,
    }));
    return {
      scope: SCOPE,
      stopped,
      already_finished: result.alreadyFinished,
      how_each_job_stops: await howEachJobStops(
        ctx.db,
        stopped.flatMap((r) => r.cancelled_job_ids),
      ),
      for_every_job: FOR_EVERY_JOB,
    };
  },
};

// ─── message_conversation_run (#531) ─────────────────────────────────────────
//
// Un message qui arrive pendant qu'un travail tourne démarre un TOUR DE RÉPONSE
// (voir @nodal-agents/db, conversation-inbox.ts). C'est par cet outil que ce
// tour fait prendre en compte le message par le travail en cours, s'il le
// juge lié : il l'écrit dans la FILE du job visé — la tête du run, ou un
// délégué encore vivant —, que ce job lit à son prochain pas et avant de
// conclure. « Je te donne suite à la fin » n'est donc pas une promesse en
// l'air : c'est une note dans la file de la tête, lue avant sa conclusion.

export const MessageConversationRunInputSchema = z.object({
  job_id: z
    .string()
    .uuid()
    .describe(
      'The job to pass the message to: a `run_id` (the head of a run), or the `job_id` of one ' +
        'of its delegated jobs still running, as `list_conversation_runs` or the "Work running ' +
        'in this conversation" block gives them.',
    ),
  message: z
    .string()
    .min(1)
    .max(8000)
    .describe(
      "What that job should take into account, written for it: the person's words, and what " +
        'they change for its work.',
    ),
});

export type MessageConversationRunInput = z.infer<typeof MessageConversationRunInputSchema>;

export type MessageConversationRunOutput = {
  delivered: true;
  job_id: string;
  /** Quand le job visé lit le message — vrai pour SON runtime. */
  read_when: string;
};

/** Quand un job lit sa file, par runtime (le même principe que `HOW_A_RUNTIME_STOPS`). */
const WHEN_A_RUNTIME_READS: Readonly<Record<string, string>> = {
  // apps/runner/src/job/execute.ts, `lireLaFile` : en haut de chaque tour, et
  // avant de conclure sur une réponse en texte.
  nodal: 'At its next step, and before it concludes: its answer takes the message into account.',
  // Un tour de CLI n'a pas de frontière de tour : la file est lue quand il finit
  // (une tête la relance, un délégué la laisse à son parent).
  'claude-code':
    'After its current Claude Code turn: a CLI turn cannot read messages while it runs, so ' +
    'the message is picked up when that turn ends.',
  codex:
    'After its current Codex turn: a CLI turn cannot read messages while it runs, so the ' +
    'message is picked up when that turn ends.',
};

export const messageConversationRunTool: ToolDefinition<
  typeof MessageConversationRunInputSchema,
  MessageConversationRunOutput
> = {
  name: 'message_conversation_run',
  label: 'Pass a message to running work',
  summary:
    'Pass a message to a run of this conversation, or to one of its delegated jobs, while it is still running. It reads it at its next step and before it concludes.',
  description:
    'Pass a message to work STILL RUNNING in this conversation: the head of a run (its ' +
    '`run_id`) or one of its delegated jobs (its `job_id`). The job reads it at its next step ' +
    'and before it concludes, so this is how the running work takes an update into account, ' +
    "or how a follow-up is handled when that work finishes. Use it when the person's message " +
    'concerns that work; for something else, start other work instead. Refused for a job that ' +
    'has already finished, or that is not in this conversation.',
  inputSchema: MessageConversationRunInputSchema,
  riskLevel: 'write',
  card: 'text',
  execute: async (input, ctx) => {
    const { conversationId, ownHeadJobId } = await callerScope(ctx.db, ctx.entityId, ctx.jobId);
    if (input.job_id === ownHeadJobId || input.job_id === ctx.jobId) {
      throw new Error(
        'conversation_runs_error: that job is your own current run. Take the message into ' +
          'account yourself.',
      );
    }
    const result = await deliverToConversationJob(ctx.db, {
      entityId: ctx.entityId,
      conversationId,
      jobId: input.job_id,
      text: input.message,
      fromJobId: ctx.jobId,
    });
    if (!result.delivered) {
      throw new Error(
        result.reason === 'not_live'
          ? `conversation_runs_error: job ${input.job_id} has already finished ` +
              `(${result.status ?? 'unknown'}); nothing was passed on. Its result is in this ` +
              'conversation; start new work if something is still to do.'
          : `conversation_runs_error: ${input.job_id} is not a job of this conversation. Use a ` +
              '`run_id` or `job_id` returned by list_conversation_runs.',
      );
    }
    const [row] = await ctx.db
      .select({ runtime: agents.runtime })
      .from(agentJobs)
      .leftJoin(agents, eq(agents.id, agentJobs.agentId))
      .where(eq(agentJobs.id, input.job_id))
      .limit(1);
    const runtime = row?.runtime ?? 'nodal';
    return {
      delivered: true,
      job_id: input.job_id,
      // Un runtime que cet outil ne décrit pas est DIT tel quel (invariant #4).
      read_when:
        WHEN_A_RUNTIME_READS[runtime] ??
        `Written to its inbox; when the runtime '${runtime}' reads it is not known to this tool.`,
    };
  },
};
