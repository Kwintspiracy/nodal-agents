// cli-runtime/run-chat.ts — the DASHBOARD-CHAT path of a runtime agent
// (étape E). Same contract as run-job.ts but for a chat turn: the user's
// message goes to the agent's Claude Code session (resumed per conversation),
// the CLI's final text is persisted as the assistant chat message VERBATIM
// (invariant #2), usage lands in cli_runs, internal tool events land in
// tool_calls (jobId null — surfaced by the Logs page).

import {
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
  assertAgentBudget,
  recordCliRun,
  assertRuntimeSessionKey,
  writeMutationIntent,
  bumpEpochsAfterJoblessWrite,
  attachProductionToProject,
  resolveRunWorkspaces,
} from '@nodal-agents/tools';
import { acquireWorkspaceLocks, WorkspaceLockedError, type HeldLocks } from './workspace-locks.ts';
import { DEFAULT_LIMITS } from '@nodal-agents/orchestration';
import { buildCliAuditRow } from './audit.ts';
import { shellPostureForTurn, watchBrakeDuringTurn } from './shell-turn.ts';
import { claudeShellTools } from '@nodal-agents/shared';
import { buildSystemPrompt } from '@nodal-agents/orchestration';
import { probeWorkspaceGit } from '../lib/workspace-git.ts';
import { type ClaudeTurnEvent } from './claude-turn.ts';
import { resolveRuntime, isCliSetupError, type CliTurnResult } from './provider.ts';
import { buildCliRuntimeJobContext } from './run-job.ts';
import { getDeploymentContext } from '../job/deployment.ts';
import { loadConversationContext } from '../job/conversation-id.ts';
import type { CliRuntimeAgentRow } from './run-job.ts';

const RUNTIME_CHAT_TIMEOUT_MS = 600_000;

export async function runCliRuntimeChatTurn(args: {
  db: AnyDrizzleDb;
  entityId: string;
  agentRow: CliRuntimeAgentRow;
  conversationId: string;
  message: string;
  /** The person's Stop (#456): kills the CLI turn; the reply is what was said so far, marked `stopped`. */
  abortSignal?: AbortSignal;
}): Promise<{ ok: true; reply: string; stopped?: boolean } | { ok: false; error: string }> {
  const { db, entityId, agentRow, message } = args;
  // Same shared-table guard as the job path — see assertRuntimeSessionKey.
  const conversationId = assertRuntimeSessionKey(args.conversationId);

  // Le MÊME tableau que le chemin job — voir provider.ts.
  const binding = resolveRuntime(agentRow.runtime);
  if (!binding) {
    return { ok: false, error: `runtime_not_supported:${agentRow.runtime}` };
  }

  // Le frein d'urgence du workspace, par la MÊME règle que le chemin job
  // (`shell-turn.ts`, #494). Ce chemin l'ignorait : le bouton rouge qui
  // arrêtait les jobs d'un agent laissait son chat lancer des commandes. Une
  // CLI qui sait perdre son shell (Claude) répond sans ; Codex, qui ne le sait
  // pas, ne répond pas.
  let shellPosture = await shellPostureForTurn(
    db,
    entityId,
    binding.provider,
    agentRow.cliPermissions,
  );
  if (shellPosture.kind === 'refused') {
    return { ok: false, error: shellPosture.reason };
  }

  // La MÊME liste que le chemin job — le partagé compris (revue Codex, 27/08) :
  // une seule fonction pour les deux points d'entrée, et pour le bloc d'équipe
  // qui la décrit à l'orchestrateur (#506). Voir resolveRunWorkspaces (tools).
  const { workspaces: wsRows } = await resolveRunWorkspaces(db, agentRow.id, entityId);
  const cwd = wsRows[0]?.path;
  if (!cwd) return { ok: false, error: 'workspace_not_configured' };

  try {
    await assertAgentBudget(db, agentRow.id);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message.slice(0, 300) : 'agent_budget_exceeded',
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
  // Le texte que le runtime a DÉJÀ dit, message par message. Claude ne rend sa
  // réponse finale que dans l'événement `result` ; un Stop qui tue le processus
  // avant lui ne laisserait rien, alors que la personne a vu ce texte s'écrire
  // (revue Codex de #459, passe 4).
  const emittedTexts: string[] = [];
  const onEvent = (evt: ClaudeTurnEvent): void => {
    if (evt.kind === 'assistant_text') {
      if (evt.text) emittedTexts.push(evt.text);
    } else if (evt.kind === 'tool_use' && evt.toolUseId && evt.toolName) {
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
          // Un harnais de code travaille sur le PROJET (v7-A).
          targets: wsRows.map((w) => ({
            kind: 'dir' as const,
            path: w.path,
            deliverableType: 'code_project' as const,
          })),
        },
      );
      if (intent.kind === 'failed') {
        throw new Error(`verification_intent_failed:${intent.code}`);
      }
    }

    const workspaceGit = await probeWorkspaceGit(cwd);
    // Le fil et son projet courant (P6) — même bloc `## Conversation` que sur le
    // chemin job : une session CLI de chat est une conversation comme une autre.
    const conversation = await loadConversationContext(db, conversationId, { task: message });
    systemPrompt = await buildSystemPrompt(
      agentRow,
      db,
      buildCliRuntimeJobContext({
        origin: 'dashboard',
        deployment: await getDeploymentContext(db, entityId),
        task: message,
        workspaceGit,
        workspaces: wsRows,
        ...(conversation ? { conversation } : {}),
      }),
    );
  } catch (err) {
    await locks.release();
    throw err;
  }

  // Le frein relu AU LANCEMENT (voir shell-turn.ts) : serré pendant la
  // préparation, il décide encore de ce tour.
  shellPosture = await shellPostureForTurn(db, entityId, binding.provider, agentRow.cliPermissions);
  if (shellPosture.kind === 'refused') {
    await locks.release();
    return { ok: false, error: shellPosture.reason };
  }

  const brake = watchBrakeDuringTurn(db, entityId, shellPosture, {
    ...(args.abortSignal ? { personStop: args.abortSignal } : {}),
  });
  let turn: CliTurnResult;
  try {
    turn = await binding.run({
      message,
      personality: systemPrompt,
      cwd,
      // Comme le chemin job — voir ClaudeTurnOptions.extraWriteDirs.
      extraWriteDirs: wsRows.slice(1).map((w) => w.path),
      mode,
      shellTools: claudeShellTools(shellPosture),
      extraDisallowed: perms.extraDisallowed,
      model: defaults.model,
      effort: defaults.effort,
      resumeSessionId: existing?.sessionId,
      timeoutMs: RUNTIME_CHAT_TIMEOUT_MS,
      ...(brake.signal ? { abortSignal: brake.signal } : {}),
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
    brake.stop();
    // ── L'ÉCRITURE FAIT VIEILLIR LE PROJET, ICI AUSSI (issue #101) ──────────
    //
    // Le chemin job monte l'époque deux fois : à l'intention, puis à la sortie
    // de la CLI. Un tour de CHAT n'a pas de jobId — l'intention ci-dessus sort
    // en `skipped` avant même de résoudre un livrable —, donc RIEN ne bougeait
    // ici : une preuve lancée par un autre job pendant ce tour capturait une
    // époque figée, prouvait l'arbre d'avant, et reposait un vert périmé.
    // C'est le même trou par une autre porte, et il se ferme par la montée qui
    // SUIT l'écriture, la seule dont ce défaut dépende.
    //
    // Dans le `finally`, donc y compris quand le binding lève ou que la CLI
    // n'a pas démarré : même contrat conservatif que partout ailleurs, et une
    // époque montée pour rien ne fait jamais qu'un `dirty` de trop.
    if (mode === 'write') {
      await bumpEpochsAfterJoblessWrite(
        { db, entityId, workspaces: wsRows },
        {
          surface: 'cliRuntime',
          targets: wsRows.map((w) => ({
            kind: 'dir' as const,
            path: w.path,
            deliverableType: 'code_project' as const,
          })),
        },
      );
    }
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

  // Le MÊME ordre de fin de tour que le chemin job (voir run-job.ts, « UN SEUL
  // ORDRE DE FIN DE TOUR ») : les enregistrements ci-dessus, puis le droit
  // d'agir — le Stop de la personne l'emporte sur le frein —, puis le verdict.
  //
  // Stop (#456) : le processus a été tué à la demande de la personne. Ce n'est
  // pas une panne du runtime — c'est la réponse arrêtée : le texte final s'il
  // en était sorti un, et le FAIT de l'arrêt (`stopped`), que l'écran dit.
  if (args.abortSignal?.aborted) {
    const reply = turn.finalText.trim() || emittedTexts.join('\n\n').trim();
    await db.insert(chatMessages).values({
      entityId,
      agentId: agentRow.id,
      conversationId,
      role: 'assistant',
      content: reply,
      stopped: true,
    });
    await db
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, conversationId));
    return { ok: true, reply, stopped: true };
  }

  // Le verdict. Le frein serré pendant le tour (#494) a tué la CLI : un échec
  // parmi les autres, dit comme au départ du tour, quoi qu'elle ait rendu.
  const brakeEngaged = brake.engaged();
  if (brakeEngaged || turn.isError || turn.finalText === '') {
    const limitHit = turn.rateLimit && turn.rateLimit.status !== 'allowed';
    return {
      ok: false,
      error: brakeEngaged
        ? 'auto_run_paused'
        : limitHit
          ? 'subscription_limit_reached'
          : `cli_runtime_error: ${(turn.errorDetail ?? 'no final text').slice(0, 200)}`,
    };
  }

  // ── Le REGISTRE des projets (P5), APRÈS un tour réussi — le JUMEAU du chemin
  // job (run-job.ts). Un tour de chat n'a pas de jobId, et la colonne de
  // rattachement vit sur agent_jobs : c'est la CONVERSATION qui porte le projet
  // ici (P6), et elle suffit. L'issue est `{ job: 'no_job', conversation: 'set' }`.
  // Après le tour, pas avant (revue Codex passe 27) : un tour en erreur n'a rien
  // produit, et le projet courant du fil ne doit pas bouger pour lui.
  // Cibles = les DOSSIERS attachés, pas les fichiers écrits (contrairement à
  // run-job.ts, P5b) : sans job, les lignes `cli:*` de l'audit n'ont pas de
  // `job_id`, et rien ne dit lesquelles sont celles de CE tour. Un tour de
  // chat ne DÉCLARE donc jamais de projet (seules les cibles fichier
  // déclarent — revue Codex, passe 32) ; il se rattache à un projet déjà
  // déclaré, et un dossier à manifeste attend un tour de JOB pour l'être.
  if (mode === 'write') {
    await attachProductionToProject(
      { db, entityId, jobId: null, conversationId, agentId: agentRow.id, workspaces: wsRows },
      wsRows.map((w) => ({
        kind: 'dir' as const,
        path: w.path,
        deliverableType: 'code_project' as const,
      })),
    );
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
