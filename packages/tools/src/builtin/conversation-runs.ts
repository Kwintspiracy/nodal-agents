// Built-in: list_conversation_runs + stop_conversation_run (#567)
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
import { agentJobs, and, eq, cancelJobTree, listConversationRuns } from '@nodal-agents/db';
import type { AnyDrizzleDb, ConversationRun } from '@nodal-agents/db';
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
  how_it_stops: string;
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

    let targets: string[];
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
      targets = [head.id];
    } else {
      const runs = await listConversationRuns(ctx.db, {
        entityId: ctx.entityId,
        conversationId,
        excludeHeadJobId: ownHeadJobId,
      });
      targets = runs.map((r) => r.headJobId);
    }

    const stopped: StopConversationRunOutput['stopped'] = [];
    const alreadyFinished: string[] = [];
    for (const runId of targets) {
      const c = await cancelJobTree(ctx.db, { entityId: ctx.entityId, jobId: runId });
      if (c.jobIds.length === 0 && c.taskIds.length === 0 && c.requestIds.length === 0) {
        alreadyFinished.push(runId);
        continue;
      }
      stopped.push({
        run_id: runId,
        cancelled_job_ids: c.jobIds,
        cancelled_task_ids: c.taskIds,
        closed_request_ids: c.requestIds,
      });
    }
    return {
      scope: SCOPE,
      stopped,
      already_finished: alreadyFinished,
      how_it_stops:
        'Cancelled jobs stop at their next step: a model or tool call already in flight ' +
        'finishes first, then nothing more runs. Closed approvals and questions can no longer ' +
        'be answered.',
    };
  },
};
