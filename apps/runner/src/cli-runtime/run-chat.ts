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
  assertRuntimeSessionKey,
  SHARED_WORKSPACE_LABEL,
  writeMutationIntent,
} from '@nodal-agents/tools';
import { resolveWorkspaceList, ensureSharedWorkspace } from '../lib/workspace-list.ts';
import { acquireWorkspaceLocks, WorkspaceLockedError, type HeldLocks } from './workspace-locks.ts';
import { DEFAULT_LIMITS } from '@nodal-agents/orchestration';
import { buildCliAuditRow } from './audit.ts';
import { buildSystemPrompt } from '@nodal-agents/orchestration';
import { probeWorkspaceGit } from '../lib/workspace-git.ts';
import { type ClaudeTurnEvent } from './claude-turn.ts';
import { resolveRuntime, isCliSetupError, type CliTurnResult } from './provider.ts';
import { buildCliRuntimeJobContext } from './run-job.ts';
import type { CliRuntimeAgentRow } from './run-job.ts';

const RUNTIME_CHAT_TIMEOUT_MS = 600_000;

export async function runCliRuntimeChatTurn(args: {
  db: AnyDrizzleDb;
  entityId: string;
  agentRow: CliRuntimeAgentRow;
  conversationId: string;
  message: string;
}): Promise<{ ok: true; reply: string } | { ok: false; error: string }> {
  const { db, entityId, agentRow, message } = args;
  // Same shared-table guard as the job path — see assertRuntimeSessionKey.
  const conversationId = assertRuntimeSessionKey(args.conversationId);

  // Le MÊME tableau que le chemin job — voir provider.ts.
  const binding = resolveRuntime(agentRow.runtime);
  if (!binding) {
    return { ok: false, error: `runtime_not_supported:${agentRow.runtime}` };
  }

  const attached = await db
    // Le LABEL compte : c'est sous ce nom que le prompt annonce chaque dossier,
    // et c'est par lui qu'un chemin relatif se résout. Le sélectionner ici
    // évite de fabriquer une étiquette vide au moment de bâtir le contexte.
    .select({ label: agentWorkspaces.label, path: agentWorkspaces.path })
    .from(agentWorkspaces)
    .where(eq(agentWorkspaces.agentId, agentRow.id))
    .orderBy(agentWorkspaces.position, agentWorkspaces.label);

  // La MÊME liste que le chemin job — le partagé compris (revue Codex, 27/08).
  //
  // Ce dossier n'a aucune ligne en base : il est fabriqué à l'exécution, et
  // `execute.ts` l'ajoutait de son côté seulement. Depuis ce chat, un agent en
  // runtime CLI ne pouvait donc ni lire ni écrire les fichiers de transmission
  // de l'équipe — et un agent SANS dossier attaché échouait en
  // `workspace_not_configured` alors que ses jobs tournaient très bien. Deux
  // points d'entrée pour le même agent, deux réalités.
  const { workspaces: wsRows } = resolveWorkspaceList(
    attached,
    SHARED_WORKSPACE_LABEL,
    ensureSharedWorkspace(entityId),
  );
  const cwd = wsRows[0]?.path;
  if (!cwd) return { ok: false, error: 'workspace_not_configured' };

  try {
    await assertCliBudget(db, agentRow.id, binding.provider);
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
      and(
        eq(cliSessions.agentId, agentRow.id),
        eq(cliSessions.conversationKey, conversationId),
        // Même règle que le chemin job : le fournisseur fait partie de
        // l'identité d'une session. Voir run-job.ts.
        eq(cliSessions.provider, binding.provider),
      ),
    )
    .limit(1);

  const perms = agentRow.cliPermissions ?? {};
  const mode: 'read' | 'write' = perms.mode ?? 'read';
  const defaults = agentRow.cliDefaults?.[binding.provider] ?? {};

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
          // Même construction que le chemin job — voir audit.ts.
          ...buildCliAuditRow({
            toolName: started.name,
            toolInput: started.input,
            toolOutput: evt.output,
            toolCallId: evt.toolUseId,
            startedAt: started.startedAt,
            now: Date.now(),
          }),
        })
        .catch((err: unknown) => {
          console.warn('[cli-runtime] chat tool_calls insert failed:', err);
        });
    }
  };

  // Single write-slot per workspace, same contract as code_task/run-job. A
  // chat turn has no jobId — the lock token is a synthetic uuid (the column
  // is a bare uuid, not an FK), released in finally.
  // TOUS les dossiers écrivables, pas seulement `cwd` — voir workspace-locks.ts.
  //
  // Le chemin job a été corrigé d'abord, et celui-ci est resté en arrière une
  // revue de plus : deux copies, un seul correctif appliqué. C'est ce qui a fait
  // sortir la prise de verrous dans son propre module.
  const lockToken = mode === 'write' ? randomUUID() : null;
  let locks: HeldLocks = { release: async () => {} };
  if (lockToken) {
    try {
      locks = await acquireWorkspaceLocks(
        db,
        wsRows.map((w) => w.path),
        lockToken,
        agentRow.id,
      );
    } catch (err) {
      if (err instanceof WorkspaceLockedError) {
        return { ok: false, error: err.message.slice(0, 300) };
      }
      throw err;
    }
  }

  // Same defect as run-job.ts, same fix: the raw personality field alone loses
  // the team block, memory, skills and workspace context that the orchestration
  // layer assembles. `surface: 'cli-runtime'` drops only the built-in tool list,
  // which describes tools this agent does not have.
  // Même oubli que le chemin job, même correctif : `workspaceGit` n'était jamais
  // transmis, donc le bloc git — livré par la PR #7 — n'atteignait pas l'agent
  // qui en a le plus besoin. Sondé sur le cwd réel de la session.
  //
  // COÛT, mesuré depuis le code plutôt que supposé : la sonde fait un
  // `rev-parse --show-toplevel` (5 s au plus) puis trois commandes en parallèle
  // (5 s au plus) — donc 10 s dans le pire cas, et des millisecondes sur un
  // dépôt sain. Ce pire cas suppose un git qui pend, ce qui est en soi le
  // signal. Assumé ici parce qu'un tour de chat CLI dure des minutes ; si ça
  // devenait sensible, c'est le TIMEOUT de la sonde qu'il faudrait réduire, pas
  // la sonde qu'il faudrait retirer.
  //
  // Sous le MÊME filet que le tour — voir run-job.ts : une panne passagère ici
  // laissait les dossiers verrouillés une demi-heure pour tout le monde.
  //
  // ── L'intention de mutation, LE JUMEAU du chemin job (T17) — nommé parce
  // qu'il a déjà été oublié une revue entière (voir workspace-locks.ts). Un
  // tour de chat n'a PAS de jobId, et la ligne d'état a une FK NOT NULL vers
  // agent_jobs : le helper rend `skipped` (no_job_context) et le DIT par un
  // code — le site d'appel existe (dans le try ci-dessous), le silence est
  // nommé, l'écran le dit dans sa branche chat (T24). Un `failed` (entité
  // vide) interdit le spawn, comme sur le chemin job.
  let systemPrompt: string;
  try {
    if (mode === 'write') {
      const intent = await writeMutationIntent(
        { db, entityId, jobId: null, workspaces: wsRows },
        {
          surface: 'cliRuntime',
          targets: wsRows.map((w) => ({ kind: 'dir' as const, path: w.path })),
        },
      );
      if (intent.kind === 'failed') {
        throw new Error(`verification_intent_failed:${intent.code}`);
      }
    }

    const workspaceGit = await probeWorkspaceGit(cwd);
    systemPrompt = await buildSystemPrompt(
      agentRow,
      db,
      buildCliRuntimeJobContext({
        origin: 'dashboard',
        task: message,
        workspaceGit,
        workspaces: wsRows,
      }),
    );
  } catch (err) {
    await locks.release();
    throw err;
  }

  let turn: CliTurnResult;
  try {
    turn = await binding.run({
      message,
      personality: systemPrompt,
      cwd,
      // Comme le chemin job — voir ClaudeTurnOptions.extraWriteDirs.
      extraWriteDirs: wsRows.slice(1).map((w) => w.path),
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
    if (isCliSetupError(err)) {
      return { ok: false, error: err.message.slice(0, 300) };
    }
    throw err;
  } finally {
    await locks.release();
  }

  try {
    await recordCliRun(db, {
      entityId,
      agentId: agentRow.id,
      jobId: null,
      provider: binding.provider,
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
        provider: binding.provider,
        sessionId: turn.sessionId,
      })
      .onConflictDoUpdate({
        target: [cliSessions.agentId, cliSessions.conversationKey],
        // `provider` reposé — voir run-job.ts.
        set: { sessionId: turn.sessionId, provider: binding.provider, updatedAt: sql`now()` },
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
