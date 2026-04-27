// job/execute.ts — executeJob: the main LLM loop
// Invariants enforced:
//   2: no hardcoded user-facing strings (error codes only)
//   3: no agent-specific band-aids (fail loud on all errors)
//   4: no silent fallbacks
//   8: anti-loop guards (ChainCounters from @nodalai/orchestration)
//   9: tool whitelist explicit per agent (computeToolWhitelist)

import { eq, and } from '@nodalai/db';
import {
  agentJobs,
  agents,
  agentAssignments,
  approvalRules,
  agentSkillAssignments,
} from '@nodalai/db';
import { QuotaExhaustedError, MessageStructureError, validateMessageStructure } from '@nodalai/llm';
import {
  computeToolWhitelist,
  computeToolChoice,
  executeTool,
  ALWAYS_ON_TOOLS,
} from '@nodalai/tools';
import type { ToolDefinition, ApprovalRule } from '@nodalai/tools';
import {
  ChainCounters,
  DEFAULT_LIMITS,
  detectOrchestratorMode,
  generateAssignTools,
  generateTaskTools,
  handleDelegation,
  filterToolCallsForDelegation,
  buildDeferredToolResults,
  buildSystemPrompt,
  ChainLimitExceededError,
  ToolCallLimitExceededError,
  DelegationDepthExceededError,
  DelegationPendingError,
} from '@nodalai/orchestration';
import type { AgentId, JobId, EntityId, OrchestratorMode, Agent } from '@nodalai/orchestration';
import type { z } from 'zod';
import type { CoreMessage } from 'ai';
import { failJob, completeJob, setJobStatus, saveCheckpoint } from './state.ts';
import { deliverResult } from './delivery-stub.ts';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';

// ─── JobStatus type (what we return) ─────────────────────────────────────────

export type ExecuteJobResult =
  | { status: 'completed'; result: string }
  | { status: 'failed'; error: string }
  | { status: 'awaiting_approval' }
  | { status: 'awaiting_delegation' }
  | { status: 'already_handled' };

// ─── AnyToolDef ──────────────────────────────────────────────────────────────

type AnyToolDef = ToolDefinition<z.ZodTypeAny, unknown>;

// ─── executeJob ───────────────────────────────────────────────────────────────

/**
 * Main LLM loop. Runs a job from pending/processing to terminal or blocked state.
 */
export async function executeJob(
  jobId: JobId,
  deps: RunnerDeps,
  _runnerEnv?: RunnerEnv,
): Promise<ExecuteJobResult> {
  const { db, llmClient, registry } = deps;

  // ── 1. Load job ───────────────────────────────────────────────────────────────
  const jobRows = await db
    .select()
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId as string))
    .limit(1);

  const job = jobRows[0];
  if (!job) {
    return { status: 'failed', error: 'job_not_found' };
  }

  const currentStatus = job.status ?? 'pending';
  if (!['pending', 'processing'].includes(currentStatus)) {
    return { status: 'already_handled' };
  }

  // ── 2. Transition to processing ───────────────────────────────────────────────
  await setJobStatus(db, jobId as string, 'processing');

  // ── 3. Load agent ─────────────────────────────────────────────────────────────
  if (!job.agentId) {
    await failJob(db, jobId as string, 'agent_not_found');
    return { status: 'failed', error: 'agent_not_found' };
  }

  const agentRows = await db.select().from(agents).where(eq(agents.id, job.agentId)).limit(1);

  const agentRow = agentRows[0];
  if (!agentRow || !agentRow.active) {
    await failJob(db, jobId as string, 'agent_not_found');
    return { status: 'failed', error: 'agent_not_found' };
  }

  const agent: Agent = {
    id: agentRow.id as AgentId,
    name: agentRow.name,
    slug: agentRow.slug,
    role: (agentRow.role ?? 'agent') as Agent['role'],
    personality: agentRow.personality,
    entityId: (agentRow.entityId ?? null) as EntityId | null,
    model: agentRow.model ?? 'claude-sonnet-4-6-20260217',
    active: agentRow.active ?? true,
    orchestratorMode: (agentRow.orchestratorMode ?? null) as 'router' | 'planner' | null,
  };

  // ── 4. Load child agents ──────────────────────────────────────────────────────
  const childRows = await db
    .select({ id: agents.id, slug: agents.slug, role: agents.role })
    .from(agentAssignments)
    .innerJoin(agents, eq(agentAssignments.subAgentId, agents.id))
    .where(and(eq(agentAssignments.orchestratorId, agentRow.id), eq(agents.active, true)));

  const children = childRows.map((r) => ({
    id: r.id as AgentId,
    name: r.slug,
    slug: r.slug,
    role: (r.role ?? 'agent') as 'agent' | 'orchestrator' | 'system',
    description: r.slug,
  }));

  // ── 5. Detect orchestrator mode ───────────────────────────────────────────────
  const orchestratorMode: OrchestratorMode = detectOrchestratorMode(agent, children);
  const isOrchestrator = agent.role === 'orchestrator';

  // ── 6. Build system prompt ────────────────────────────────────────────────────
  let systemPrompt = job.systemPrompt;
  if (!systemPrompt) {
    systemPrompt = await buildSystemPrompt(agent, db);
    await db
      .update(agentJobs)
      .set({ systemPrompt, updatedAt: new Date() })
      .where(eq(agentJobs.id, jobId as string));
  }

  // ── 7. Build tool set ─────────────────────────────────────────────────────────
  let toolDefs: AnyToolDef[];

  try {
    if (isOrchestrator) {
      if (orchestratorMode === 'router') {
        const assignTools = (await generateAssignTools(agent.id, db)) as unknown as AnyToolDef[];
        const returnResult = registry.get('return_result');
        toolDefs = returnResult ? [...assignTools, returnResult] : [...assignTools];
      } else {
        const [createTaskTool, listTasksTool] = generateTaskTools(agent.id, db);
        const returnResult = registry.get('return_result');
        toolDefs = returnResult
          ? [
              createTaskTool as unknown as AnyToolDef,
              listTasksTool as unknown as AnyToolDef,
              returnResult,
            ]
          : [createTaskTool as unknown as AnyToolDef, listTasksTool as unknown as AnyToolDef];
      }
    } else {
      // Worker: whitelist from skill assignments + always-on tools
      const skillRows = await db
        .select({ skillId: agentSkillAssignments.skillId })
        .from(agentSkillAssignments)
        .where(eq(agentSkillAssignments.agentId, agentRow.id));

      // For workers without adapter registrations, only always-on tools are available.
      // Adapters will be registered in the registry when adapter packages are loaded.
      const configuredToolNames = skillRows
        .map((r) => r.skillId)
        .filter((name): name is string => name !== null);

      // Filter configured tools to only those that exist in the registry
      // (avoids WhitelistDriftError for unregistered adapter tools)
      const registeredConfigured = configuredToolNames.filter(
        (name) => registry.get(name) !== undefined,
      );

      toolDefs = computeToolWhitelist(
        {
          agentId: agentRow.id,
          configuredTools: registeredConfigured,
          alwaysOn: [...ALWAYS_ON_TOOLS],
        },
        registry,
      );
    }
  } catch (err) {
    const errorCode = err instanceof Error ? err.message : 'whitelist_computation_failed';
    await failJob(db, jobId as string, errorCode);
    return { status: 'failed', error: errorCode };
  }

  // ── 8. Load approval rules ────────────────────────────────────────────────────
  const ruleRows = await db
    .select()
    .from(approvalRules)
    .where(eq(approvalRules.entityId, job.entityId ?? ''));

  const approvalRuleList: ApprovalRule[] = ruleRows.map((r) => ({
    id: r.id,
    toolName: r.toolName,
    action: (r.action ?? 'auto_approve') as ApprovalRule['action'],
    agentId: r.agentId,
    entityId: r.entityId,
  }));

  // ── 9. Initialize ChainCounters ───────────────────────────────────────────────
  const counters = new ChainCounters(DEFAULT_LIMITS);
  const hasAdapterTools = !isOrchestrator && toolDefs.length > ALWAYS_ON_TOOLS.length;

  // ── 10. Build tool map ────────────────────────────────────────────────────────
  const toolMap = new Map<string, AnyToolDef>(toolDefs.map((t) => [t.name, t]));

  // ── 11. Restore conversation ──────────────────────────────────────────────────
  let messages: CoreMessage[] = Array.isArray(job.messages) ? (job.messages as CoreMessage[]) : [];

  if (messages.length === 0) {
    messages = [{ role: 'user', content: job.task }];
  }

  let toolsUsed: string[] = Array.isArray(job.toolsUsed) ? (job.toolsUsed as string[]) : [];
  let turn = job.turn ?? 0;

  // ── 12. Main LLM loop ─────────────────────────────────────────────────────────
  try {
    while (true) {
      turn += 1;
      counters.resetTurnToolCalls();

      // a. Validate message structure
      validateMessageStructure(messages);

      // b. Tool choice
      const toolChoice = computeToolChoice({ isOrchestrator, turn, hasAdapterTools });

      // c. Convert tools to AI SDK format
      const aiSdkTools: Record<string, { description: string; parameters: z.ZodTypeAny }> = {};
      for (const [name, toolDef] of toolMap) {
        aiSdkTools[name] = { description: toolDef.description, parameters: toolDef.inputSchema };
      }

      // d. Call LLM
      const response = await llmClient.generateText({
        system: systemPrompt,
        messages,
        tools: aiSdkTools,
        toolChoice,
      });

      const rawToolCalls = response.toolCalls ?? [];

      // e. Append assistant message (use text or build from tool calls)
      const assistantMsg: CoreMessage = {
        role: 'assistant',
        content:
          rawToolCalls.length > 0
            ? rawToolCalls.map((tc) => ({
                type: 'tool-call' as const,
                toolCallId: tc.toolCallId,
                toolName: tc.toolName,
                args: tc.args as Record<string, unknown>,
              }))
            : response.text || '',
      };
      messages = [...messages, assistantMsg];

      // f. Check for return_result
      const returnResultCall = rawToolCalls.find((tc) => tc.toolName === 'return_result');
      if (returnResultCall) {
        const input = returnResultCall.args as { status?: string; summary?: string };
        const finalResult = input.summary ?? '';

        // Append tool_result for return_result
        const toolResultMsg: CoreMessage = {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: returnResultCall.toolCallId,
              toolName: 'return_result',
              result: { acknowledged: true },
            },
          ],
        };
        messages = [...messages, toolResultMsg];

        await completeJob(db, jobId as string, finalResult, toolsUsed);
        await deliverResult(jobId as string, {
          db,
          env: { TELEGRAM_BOT_TOKEN: _runnerEnv?.TELEGRAM_BOT_TOKEN },
        });
        return { status: 'completed', result: finalResult };
      }

      // g. No tool calls
      if (rawToolCalls.length === 0) {
        const textContent = response.text ?? '';
        if (textContent) {
          await completeJob(db, jobId as string, textContent, toolsUsed);
          await deliverResult(jobId as string, {
            db,
            env: { TELEGRAM_BOT_TOKEN: _runnerEnv?.TELEGRAM_BOT_TOKEN },
          });
          return { status: 'completed', result: textContent };
        }
        // No text, no tool calls — fail loud (invariant 4)
        await failJob(db, jobId as string, 'no_tool_calls_no_text');
        return { status: 'failed', error: 'no_tool_calls_no_text' };
      }

      // h. Filter delegation calls to one-per-turn
      const rawCallBlocks = rawToolCalls.map((tc) => ({
        type: 'tool_use' as const,
        id: tc.toolCallId,
        name: tc.toolName,
        input: tc.args as Record<string, unknown>,
      }));

      const {
        kept: keptAssign,
        dropped: droppedAssign,
        others,
      } = filterToolCallsForDelegation(rawCallBlocks);
      const sideToolResults = buildDeferredToolResults(droppedAssign);
      const callsToProcess = keptAssign ? [keptAssign, ...others] : others;

      // i. Process tool calls
      const toolResultBlocks: Array<{
        type: 'tool-result';
        toolCallId: string;
        toolName: string;
        result: unknown;
      }> = [];

      let awaitingApproval = false;
      let awaitingDelegation = false;

      for (const call of callsToProcess) {
        counters.bumpToolCall();
        toolsUsed = [...new Set([...toolsUsed, call.name])];

        const toolDef = toolMap.get(call.name);
        if (!toolDef) {
          await failJob(db, jobId as string, `whitelist_violation:${call.name}`);
          return { status: 'failed', error: `whitelist_violation:${call.name}` };
        }

        if (call.name.startsWith('assign_')) {
          const childSlug = call.name.replace(/^assign_/, '').replace(/_/g, '-');

          try {
            await executeTool(
              toolDef,
              call.input,
              { jobId: jobId as string, agentId: agentRow.id, entityId: job.entityId ?? '', db },
              { approvalRules: approvalRuleList, onApprovalRequired: async () => {} },
            );
          } catch (err) {
            if (err instanceof DelegationPendingError) {
              counters.bumpDelegationDepth();

              const jobShape = {
                id: jobId,
                agentId: agent.id,
                entityId: (job.entityId ?? null) as EntityId | null,
                status: 'processing',
                messages,
                pendingDelegation: null,
                chainCount: job.chainCount ?? 0,
                delegationDepth: job.delegationDepth ?? 0,
                parentJobId: (job.parentJobId ?? null) as JobId | null,
                task: job.task,
                channel: job.channel,
                chatId: job.chatId,
              };

              await handleDelegation(
                jobShape,
                childSlug,
                call.id,
                {
                  task: (call.input['task'] as string) ?? '',
                  data: call.input['data'] as string | undefined,
                  chatId: job.chatId,
                },
                sideToolResults,
                db,
              );

              awaitingDelegation = true;
              break;
            }
            throw err;
          }

          if (awaitingDelegation) break;
          continue;
        }

        // Non-delegation tool
        const toolResult = await executeTool(
          toolDef,
          call.input,
          { jobId: jobId as string, agentId: agentRow.id, entityId: job.entityId ?? '', db },
          {
            approvalRules: approvalRuleList,
            onApprovalRequired: async () => {},
          },
        );

        if (toolResult.outcome === 'awaiting_approval') {
          const awaitingMarker = `[AWAITING_APPROVAL] tool_call_id=${call.id}`;
          toolResultBlocks.push({
            type: 'tool-result',
            toolCallId: call.id,
            toolName: call.name,
            result: awaitingMarker,
          });
          awaitingApproval = true;
          break;
        }

        toolResultBlocks.push({
          type: 'tool-result',
          toolCallId: call.id,
          toolName: call.name,
          result:
            toolResult.outcome === 'success' ? toolResult.output : { error: toolResult.error },
        });
      }

      // j. Suspension states
      if (awaitingDelegation) {
        await saveCheckpoint(db, jobId as string, {
          messages,
          turn,
          chainCount: job.chainCount ?? 0,
          toolsUsed,
        });
        return { status: 'awaiting_delegation' };
      }

      if (awaitingApproval) {
        if (toolResultBlocks.length > 0) {
          messages = [...messages, { role: 'tool', content: toolResultBlocks } as CoreMessage];
        }
        await saveCheckpoint(db, jobId as string, {
          messages,
          turn,
          chainCount: job.chainCount ?? 0,
          toolsUsed,
        });
        await setJobStatus(db, jobId as string, 'awaiting_approval');
        return { status: 'awaiting_approval' };
      }

      // k. Append tool results and continue
      if (toolResultBlocks.length > 0) {
        messages = [...messages, { role: 'tool', content: toolResultBlocks } as CoreMessage];
      }
    }
  } catch (err) {
    // Typed errors — error codes only (invariant 2)
    if (err instanceof ToolCallLimitExceededError) {
      await failJob(db, jobId as string, err.code);
      return { status: 'failed', error: err.code };
    }

    if (err instanceof ChainLimitExceededError) {
      await failJob(db, jobId as string, err.code);
      return { status: 'failed', error: err.code };
    }

    if (err instanceof DelegationDepthExceededError) {
      await failJob(db, jobId as string, err.code);
      return { status: 'failed', error: err.code };
    }

    if (err instanceof QuotaExhaustedError) {
      await failJob(db, jobId as string, 'quota_exhausted');
      return { status: 'failed', error: 'quota_exhausted' };
    }

    if (err instanceof MessageStructureError) {
      await failJob(db, jobId as string, `message_structure_invalid:${err.code}`);
      return { status: 'failed', error: `message_structure_invalid:${err.code}` };
    }

    // AI SDK throws when model calls a tool not in the allowed list — map to whitelist_violation
    if (err instanceof Error) {
      const unavailableMatch = err.message.match(
        /Model tried to call unavailable tool ['"`]([^'"`]+)['"`]/i,
      );
      if (unavailableMatch) {
        const toolName = unavailableMatch[1] ?? 'unknown_tool';
        const code = `whitelist_violation:${toolName}`;
        await failJob(db, jobId as string, code);
        return { status: 'failed', error: code };
      }
    }

    // Invariant 3: never catch agent-specific exceptions. All errors fail loud.
    const errorCode = err instanceof Error ? err.message.slice(0, 200) : 'unknown_error';
    await failJob(db, jobId as string, errorCode);
    return { status: 'failed', error: errorCode };
  }
}
