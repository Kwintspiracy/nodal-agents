// cli-runtime/run-chat.ts — the DASHBOARD-CHAT path of a runtime agent
// (étape E). Same contract as run-job.ts but for a chat turn: the user's
// message goes to the agent's Claude Code session (resumed per conversation),
// the CLI's final text is persisted as the assistant chat message VERBATIM
// (invariant #2), usage lands in cli_runs, internal tool events land in
// tool_calls (jobId null — surfaced by the Logs page).

import {
  agentWorkspaces,
  chatMessages,
  conversations,
  cliSessions,
  toolCalls,
  eq,
  and,
  sql,
  type AnyDrizzleDb,
} from '@nodal-agents/db';
import { randomUUID } from 'node:crypto';
import {
  assertCliBudget,
  recordCliRun,
  acquireWorkspaceLock,
  releaseWorkspaceLock,
  WorkspaceLockedError,
} from '@nodal-agents/tools';
import { DEFAULT_LIMITS } from '@nodal-agents/orchestration';
import { redactSecretsForAudit } from '@nodal-agents/shared';
import { runClaudeTurn, ClaudeCliNotFoundError, type ClaudeTurnEvent } from './claude-turn.ts';
import type { CliRuntimeAgentRow } from './run-job.ts';

const RUNTIME_CHAT_TIMEOUT_MS = 600_000;

export async function runCliRuntimeChatTurn(args: {
  db: AnyDrizzleDb;
  entityId: string;
  agentRow: CliRuntimeAgentRow;
  conversationId: string;
  message: string;
}): Promise<{ ok: true; reply: string } | { ok: false; error: string }> {
  const { db, entityId, agentRow, conversationId, message } = args;

  if (agentRow.runtime !== 'claude-code') {
    return { ok: false, error: `runtime_not_supported:${agentRow.runtime}` };
  }

  const wsRows = await db
    .select({ path: agentWorkspaces.path })
    .from(agentWorkspaces)
    .where(eq(agentWorkspaces.agentId, agentRow.id))
    .orderBy(agentWorkspaces.position, agentWorkspaces.label);
  const cwd = wsRows[0]?.path;
  if (!cwd) return { ok: false, error: 'workspace_not_configured' };

  try {
    await assertCliBudget(db, agentRow.id);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message.slice(0, 300) : 'cli_daily_budget_exceeded',
    };
  }

  const [existing] = await db
    .select({ sessionId: cliSessions.sessionId })
    .from(cliSessions)
    .where(
      and(eq(cliSessions.agentId, agentRow.id), eq(cliSessions.conversationKey, conversationId)),
    )
    .limit(1);

  const perms = agentRow.cliPermissions ?? {};
  const mode: 'read' | 'write' = perms.mode ?? 'read';
  const defaults = agentRow.cliDefaults?.claude ?? {};

  const pending = new Map<string, { name: string; input: unknown; startedAt: number }>();
  const onEvent = (evt: ClaudeTurnEvent): void => {
    if (evt.kind === 'tool_use' && evt.toolUseId && evt.toolName) {
      pending.set(evt.toolUseId, { name: evt.toolName, input: evt.input, startedAt: Date.now() });
    } else if (evt.kind === 'tool_result' && evt.toolUseId) {
      const started = pending.get(evt.toolUseId);
      if (!started) return;
      pending.delete(evt.toolUseId);
      void db
        .insert(toolCalls)
        .values({
          entityId,
          jobId: null,
          toolName: `cli:${started.name}`,
          toolInput: redactSecretsForAudit(started.input) as Record<string, unknown>,
          toolOutput: evt.output ?? '',
          durationMs: Date.now() - started.startedAt,
          toolCallId: evt.toolUseId,
        })
        .catch((err: unknown) => {
          console.warn('[cli-runtime] chat tool_calls insert failed:', err);
        });
    }
  };

  // Single write-slot per workspace, same contract as code_task/run-job. A
  // chat turn has no jobId — the lock token is a synthetic uuid (the column
  // is a bare uuid, not an FK), released in finally.
  const lockToken = mode === 'write' ? randomUUID() : null;
  if (lockToken) {
    try {
      await acquireWorkspaceLock(db, cwd, lockToken, agentRow.id);
    } catch (err) {
      if (err instanceof WorkspaceLockedError) {
        return { ok: false, error: err.message.slice(0, 300) };
      }
      throw err;
    }
  }

  let turn: Awaited<ReturnType<typeof runClaudeTurn>>;
  try {
    turn = await runClaudeTurn({
      message,
      personality: agentRow.personality,
      cwd,
      mode,
      extraDisallowed: perms.extraDisallowed,
      model: defaults.model,
      effort: defaults.effort,
      resumeSessionId: existing?.sessionId,
      timeoutMs: RUNTIME_CHAT_TIMEOUT_MS,
      // Same anti-loop cap as the job path (invariant #8).
      maxToolCalls: DEFAULT_LIMITS.maxToolCallsPerTurn,
      onEvent,
    });
  } catch (err) {
    if (err instanceof ClaudeCliNotFoundError) {
      return { ok: false, error: err.message.slice(0, 300) };
    }
    throw err;
  } finally {
    if (lockToken) {
      await releaseWorkspaceLock(db, cwd, lockToken).catch((err: unknown) => {
        console.warn('[cli-runtime] chat workspace lock release failed:', err);
      });
    }
  }

  try {
    await recordCliRun(db, {
      entityId,
      agentId: agentRow.id,
      jobId: null,
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
      cacheCreationTokens: turn.usage?.cacheCreationTokens ?? null,
      modelUsage: turn.modelUsage,
      durationMs: turn.durationMs,
      cliVersion: null,
      exitCode: turn.exitCode,
    });
  } catch (err) {
    console.warn('[cli-runtime] chat cli_runs audit insert failed:', err);
  }

  if (turn.sessionId) {
    await db
      .insert(cliSessions)
      .values({
        entityId,
        agentId: agentRow.id,
        conversationKey: conversationId,
        provider: 'claude',
        sessionId: turn.sessionId,
      })
      .onConflictDoUpdate({
        target: [cliSessions.agentId, cliSessions.conversationKey],
        set: { sessionId: turn.sessionId, updatedAt: sql`now()` },
      })
      .catch((err: unknown) => {
        console.warn('[cli-runtime] chat cli_sessions upsert failed:', err);
      });
  }

  if (turn.isError || turn.finalText === '') {
    const limitHit = turn.rateLimit && turn.rateLimit.status !== 'allowed';
    return {
      ok: false,
      error: limitHit
        ? 'subscription_limit_reached'
        : `cli_runtime_error: ${(turn.errorDetail ?? 'no final text').slice(0, 200)}`,
    };
  }

  await db.insert(chatMessages).values({
    entityId,
    agentId: agentRow.id,
    conversationId,
    role: 'assistant',
    content: turn.finalText,
  });
  await db
    .update(conversations)
    .set({ updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));

  return { ok: true, reply: turn.finalText };
}
