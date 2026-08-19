// cli-runtime/run-job.ts — the JOB path of a runtime agent (étape E).
//
// executeJob diverts here as soon as the loaded agent has runtime !==
// 'nodal': the whole Nodal LLM loop is skipped and the turn is served by the
// user's own coding CLI. What stays Nodal's (the dispatcher role, said as-is
// to the user): the job lifecycle (claim/heartbeat/complete/fail — so
// reapers, parent delegation resume and the Runs page all keep working), the
// workspace as perimeter, the per-agent daily budget, session continuity per
// conversation, the audit (cli_runs + live tool_calls), and channel delivery
// of the final text VERBATIM (invariant #2).

import {
  cliSessions,
  toolCalls,
  eq,
  and,
  sql,
  isConversationAllowed,
  getBindingCredentials,
  type AnyDrizzleDb,
} from '@nodal-agents/db';
import {
  getAdapter,
  resolveTransportChannel,
  listActiveChannelsForAgent,
} from '@nodal-agents/delivery';
import { assertCliBudget, recordCliRun } from '@nodal-agents/tools';
import { redactSecretsForAudit } from '@nodal-agents/shared';
import { failJob, completeJob, touchJob } from '../job/state.ts';
import { runClaudeTurn, ClaudeCliNotFoundError, type ClaudeTurnEvent } from './claude-turn.ts';

/** Per-turn wall clock budget — a runtime agent turn is a full CLI session run. */
const RUNTIME_TURN_TIMEOUT_MS = 900_000;

export interface CliRuntimeAgentRow {
  id: string;
  entityId: string | null;
  personality: string;
  runtime: string;
  cliPermissions: { mode?: 'read' | 'write'; extraDisallowed?: string[] } | null;
  cliDefaults: { claude?: { model?: string; effort?: string } } | null;
}

export interface CliRuntimeJobRow {
  entityId: string | null;
  chatId: string | null;
  channel: string | null;
  conversationId: string | null;
  task: string | null;
}

export async function runCliRuntimeJob(args: {
  db: AnyDrizzleDb;
  jobId: string;
  job: CliRuntimeJobRow;
  agentRow: CliRuntimeAgentRow;
  workspaces: Array<{ label: string; path: string }>;
}): Promise<{ status: 'completed'; result: string } | { status: 'failed'; error: string }> {
  const { db, jobId, job, agentRow } = args;

  const fail = async (code: string): Promise<{ status: 'failed'; error: string }> => {
    await failJob(db, jobId, code);
    return { status: 'failed', error: code };
  };

  // 'codex' is reserved data — implemented later behind the same seam.
  if (agentRow.runtime !== 'claude-code') {
    return fail(`runtime_not_supported:${agentRow.runtime}`);
  }

  // The workspace IS the perimeter of a runtime agent — no workspace, no run.
  const cwd = args.workspaces[0]?.path;
  if (!cwd) {
    return fail('workspace_not_configured');
  }

  // Daily notional budget — same counter as code_task (cli_runs).
  try {
    await assertCliBudget(db, agentRow.id);
  } catch (err) {
    return fail(err instanceof Error ? err.message.slice(0, 300) : 'cli_daily_budget_exceeded');
  }

  // Session continuity: one CLI session per (agent, conversation).
  const conversationKey = job.conversationId ?? job.chatId;
  let resumeSessionId: string | undefined;
  if (conversationKey) {
    const [existing] = await db
      .select({ sessionId: cliSessions.sessionId })
      .from(cliSessions)
      .where(
        and(eq(cliSessions.agentId, agentRow.id), eq(cliSessions.conversationKey, conversationKey)),
      )
      .limit(1);
    resumeSessionId = existing?.sessionId;
  }

  const perms = agentRow.cliPermissions ?? {};
  const mode: 'read' | 'write' = perms.mode ?? 'read';
  const defaults = agentRow.cliDefaults?.claude ?? {};

  // Live observability (vs dsh's thrown-away stream): each CLI-internal tool
  // event becomes a tool_calls row as it happens, so the existing Runs page
  // shows the session working in real time. Rows pair tool_use → tool_result
  // by the CLI's own tool_use id.
  const pending = new Map<string, { name: string; input: unknown; startedAt: number }>();
  const onEvent = (evt: ClaudeTurnEvent): void => {
    if (evt.kind === 'tool_use' && evt.toolUseId && evt.toolName) {
      pending.set(evt.toolUseId, {
        name: evt.toolName,
        input: evt.input,
        startedAt: Date.now(),
      });
      return;
    }
    if (evt.kind === 'tool_result' && evt.toolUseId) {
      const started = pending.get(evt.toolUseId);
      if (!started) return;
      pending.delete(evt.toolUseId);
      void db
        .insert(toolCalls)
        .values({
          entityId: job.entityId,
          jobId,
          // Namespaced so a CLI-internal Read is never confused with a Nodal
          // builtin in the Logs/Runs surfaces.
          toolName: `cli:${started.name}`,
          toolInput: redactSecretsForAudit(started.input) as Record<string, unknown>,
          toolOutput: evt.output ?? '',
          durationMs: Date.now() - started.startedAt,
          toolCallId: evt.toolUseId,
        })
        .catch((err: unknown) => {
          console.warn(`[cli-runtime] tool_calls insert failed (job=${jobId}):`, err);
        });
    }
  };

  // Keep the job alive under the 5-minute reaper for the whole CLI run.
  const heartbeat = setInterval(() => {
    void touchJob(db, jobId).catch(() => {});
  }, 60_000);

  let turn: Awaited<ReturnType<typeof runClaudeTurn>>;
  try {
    turn = await runClaudeTurn({
      message: job.task ?? '',
      personality: agentRow.personality,
      cwd,
      mode,
      extraDisallowed: perms.extraDisallowed,
      model: defaults.model,
      effort: defaults.effort,
      resumeSessionId,
      timeoutMs: RUNTIME_TURN_TIMEOUT_MS,
      onEvent,
    });
  } catch (err) {
    clearInterval(heartbeat);
    if (err instanceof ClaudeCliNotFoundError) return fail(err.message.slice(0, 300));
    throw err;
  }
  clearInterval(heartbeat);

  // Audit — one cli_runs row per turn, success or failure (the cost is real).
  try {
    await recordCliRun(db, {
      entityId: job.entityId,
      agentId: agentRow.id,
      jobId,
      provider: 'claude',
      mode,
      source: 'subscription',
      sessionId: turn.sessionId,
      model: defaults.model ?? null,
      effort: defaults.effort ?? null,
      costUsd: turn.costUsd,
      inputTokens: turn.usage?.inputTokens ?? null,
      outputTokens: turn.usage?.outputTokens ?? null,
      cachedTokens: turn.usage?.cachedTokens ?? null,
      durationMs: turn.durationMs,
      cliVersion: null,
      exitCode: turn.exitCode,
    });
  } catch (err) {
    console.warn(`[cli-runtime] cli_runs audit insert failed (job=${jobId}):`, err);
  }

  // Persist the session mapping so the NEXT message on this conversation
  // resumes the same CLI session.
  if (conversationKey && turn.sessionId) {
    await db
      .insert(cliSessions)
      .values({
        entityId: job.entityId,
        agentId: agentRow.id,
        conversationKey,
        provider: 'claude',
        sessionId: turn.sessionId,
      })
      .onConflictDoUpdate({
        target: [cliSessions.agentId, cliSessions.conversationKey],
        set: { sessionId: turn.sessionId, updatedAt: sql`now()` },
      })
      .catch((err: unknown) => {
        console.warn(`[cli-runtime] cli_sessions upsert failed (job=${jobId}):`, err);
      });
  }

  if (turn.isError || turn.finalText === '') {
    // An exhausted subscription window must read as exactly that (D0/risques).
    const limitHit = turn.rateLimit && turn.rateLimit.status !== 'allowed';
    const code = limitHit
      ? `subscription_limit_reached: the owner's Claude plan window is exhausted` +
        (turn.rateLimit?.resetsAt
          ? ` (resets at ${new Date(turn.rateLimit.resetsAt * 1000).toISOString()})`
          : '') +
        `. ${turn.errorDetail ?? ''}`
      : `cli_runtime_error: ${turn.errorDetail ?? 'no final text'}`;
    return fail(code.slice(0, 400));
  }

  await completeJob(db, jobId, turn.finalText, ['cli:claude-code']);

  // Channel delivery — the CLI's text VERBATIM (invariant #2: the LLM speaks,
  // Nodal relays; no synthesis). Same guardrails as deliverCompletedRoots.
  if (job.chatId && turn.finalText.trim()) {
    try {
      const activeChannels = await listActiveChannelsForAgent(db, agentRow.id);
      const channel = resolveTransportChannel(job.channel ?? undefined, activeChannels);
      const allowed =
        job.entityId !== null &&
        (await isConversationAllowed(db, {
          entityId: job.entityId,
          agentId: agentRow.id,
          channel,
          conversationId: job.chatId,
        }));
      if (allowed) {
        const creds = await getBindingCredentials(db, agentRow.id, channel);
        if (creds) {
          await getAdapter(channel).sendText(creds, job.chatId, turn.finalText);
        }
      } else {
        console.error(
          `[cli-runtime] refusing delivery for job ${jobId} — chatId not in the channel allowlist`,
        );
      }
    } catch (err) {
      console.error(`[cli-runtime] channel delivery failed for job ${jobId}:`, err);
    }
  }

  return { status: 'completed', result: turn.finalText };
}
