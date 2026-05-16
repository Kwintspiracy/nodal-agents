// job/execute.ts — executeJob: the main LLM loop
// Invariants enforced:
//   2: no hardcoded user-facing strings (error codes only)
//   3: no agent-specific band-aids (fail loud on all errors)
//   4: no silent fallbacks
//   8: anti-loop guards (ChainCounters from @nodal-agents/orchestration)
//   9: tool whitelist explicit per agent (computeToolWhitelist)

import { eq, and } from '@nodal-agents/db';
import {
  agentJobs,
  agents,
  agentAssignments,
  agentTasks,
  approvalRules,
  agentSkillAssignments,
  entityLlmKeys,
  agentConnectorAssignments,
  connectors as connectorsTable,
  getDecryptedCredentialById,
} from '@nodal-agents/db';
import { ADAPTER_REGISTRY } from '@nodal-agents/runner-adapters';
import {
  QuotaExhaustedError,
  MessageStructureError,
  validateMessageStructure,
  createLlmClient,
} from '@nodal-agents/llm';
import type { NodalLlmClient } from '@nodal-agents/llm';
import {
  computeToolWhitelist,
  computeToolChoice,
  executeTool,
  ALWAYS_ON_TOOLS,
  createTelegramSendMessageTool,
} from '@nodal-agents/tools';
import type { ToolDefinition, ApprovalRule } from '@nodal-agents/tools';
import {
  ChainCounters,
  DEFAULT_LIMITS,
  detectOrchestratorMode,
  generateAssignTools,
  generateTaskTools,
  handleDelegation,
  resumeDelegated,
  filterToolCallsForDelegation,
  buildDeferredToolResults,
  buildSystemPrompt,
  ChainLimitExceededError,
  ToolCallLimitExceededError,
  DelegationDepthExceededError,
  DelegationPendingError,
} from '@nodal-agents/orchestration';
import { decrypt } from '@nodal-agents/secrets';
import type {
  AgentId,
  JobId,
  EntityId,
  OrchestratorMode,
  Agent,
  JobContext,
} from '@nodal-agents/orchestration';
import type { z } from 'zod';
import type { ModelMessage } from 'ai';
import { failJob, completeJob, setJobStatus, saveCheckpoint } from './state.ts';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';

// Per-result char budget for tool outputs entering the conversation. A single
// tool (e.g. firecrawl_scrape returning a full web page) can otherwise inject
// 100K+ tokens into `messages`, which every subsequent turn re-sends to the
// LLM — the cost multiplier behind runaway jobs. We truncate to a fixed budget
// with an explicit marker so the model knows content was cut and can re-scrape
// a narrower target. Tunable; 50K chars ≈ ~13K tokens.
const MAX_TOOL_RESULT_CHARS = 50_000;

/** Truncate an oversized tool-result string with an explicit, model-readable marker. */
function truncateForContext(value: string): string {
  if (value.length <= MAX_TOOL_RESULT_CHARS) return value;
  const dropped = value.length - MAX_TOOL_RESULT_CHARS;
  return (
    value.slice(0, MAX_TOOL_RESULT_CHARS) +
    `\n\n[... truncated: ${dropped} chars dropped (total ${value.length}) ...]`
  );
}

// ─── JobStatus type (what we return) ─────────────────────────────────────────

export type ExecuteJobResult =
  | { status: 'completed'; result: string }
  | { status: 'failed'; error: string }
  | { status: 'awaiting_approval' }
  | { status: 'awaiting_delegation' }
  | { status: 'awaiting_tasks' }
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
  const { db, registry } = deps;
  // llmClient is resolved per-job from the agent's llmKeyId (Brique 24/25).
  // Agents MUST have an llmKeyId — if absent we fail loud (invariant 4).
  // deps.llmClient is kept in RunnerDeps for backward compat with tests but
  // execute.ts no longer reads from it at runtime.
  // Definite assignment: llmClient is set unconditionally in the resolution
  // block below (or the function returns early with a failed status).
  let llmClient!: NodalLlmClient;

  // Wall-clock timer for total_duration_ms persistence. Captured at function
  // entry so it includes job/agent loading, not just the LLM loop.
  const startedAt = Date.now();

  // Trace logger — minimal, prefixed with jobId for grep. Goes to runner.log
  // via stderr so we can reconstruct what happened to a job after the fact.
  const trace = (event: string, data?: Record<string, unknown>): void => {
    console.error(`[exec ${jobId}] ${event}`, data ? JSON.stringify(data) : '');
  };
  trace('enter');

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

  // Invariant 8: chain_count is bumped on every resume from awaiting_delegation
  // (and would also be bumped on awaiting_approval resume once that path ships).
  // Cap at maxChains so a runaway orchestrator that delegates forever instead
  // of calling return_result fails loud rather than spinning indefinitely.
  if ((job.chainCount ?? 0) >= DEFAULT_LIMITS.maxChains) {
    await failJob(db, jobId as string, 'chain_limit_exceeded', {
      inputTokens: job.inputTokens ?? 0,
      outputTokens: job.outputTokens ?? 0,
      turn: job.turn ?? 0,
      totalDurationMs: 0,
    });
    return { status: 'failed', error: 'chain_limit_exceeded' };
  }

  // Run-stats accumulators — declared before the first failJob call so all
  // failure paths persist tokens / turn / duration. Seeded from the row so
  // resumed jobs don't reset to 0. AI SDK v4 returns
  // `usage: { promptTokens, completionTokens, totalTokens }`.
  let inputTokens = job.inputTokens ?? 0;
  let outputTokens = job.outputTokens ?? 0;
  let turn = job.turn ?? 0;
  let toolsUsed: string[] = Array.isArray(job.toolsUsed) ? (job.toolsUsed as string[]) : [];

  const runStats = (): {
    inputTokens: number;
    outputTokens: number;
    turn: number;
    totalDurationMs: number;
  } => ({
    inputTokens,
    outputTokens,
    turn,
    totalDurationMs: Date.now() - startedAt,
  });

  // ── 2. Transition to processing ───────────────────────────────────────────────
  await setJobStatus(db, jobId as string, 'processing');

  // ── 3. Load agent ─────────────────────────────────────────────────────────────
  if (!job.agentId) {
    await failJob(db, jobId as string, 'agent_not_found', runStats());
    return { status: 'failed', error: 'agent_not_found' };
  }

  const agentRows = await db.select().from(agents).where(eq(agents.id, job.agentId)).limit(1);

  const agentRow = agentRows[0];
  if (!agentRow || !agentRow.active) {
    await failJob(db, jobId as string, 'agent_not_found', runStats());
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
    memoryTokenBudget: agentRow.memoryTokenBudget,
  };

  // ── Per-agent LLM client resolution (Brique 24/25) ───────────────────────
  // Agents MUST have an llmKeyId pointing at an active entity_llm_keys row.
  // No env-based fallback — fail loud (invariant 4).
  // The agent's `model` column wins over the key's defaultModel (the key's
  // defaultModel is just a UI suggestion).
  if (!agentRow.llmKeyId) {
    await failJob(db, jobId as string, 'agent_no_llm_configured', runStats());
    return { status: 'failed', error: 'agent_no_llm_configured' };
  }

  {
    const [keyRow] = await db
      .select()
      .from(entityLlmKeys)
      .where(eq(entityLlmKeys.id, agentRow.llmKeyId))
      .limit(1);

    if (!keyRow || !keyRow.isActive) {
      await failJob(db, jobId as string, 'agent_no_llm_configured', runStats());
      return { status: 'failed', error: 'agent_no_llm_configured' };
    }

    try {
      // Decrypt the at-rest ciphertext (Brique 26). Throws on tamper / wrong
      // master key — caught below and surfaced as llm_key_invalid (invariant 4).
      const plaintextKey = keyRow.apiKey ? decrypt(keyRow.apiKey) : '';
      llmClient = createLlmClient({
        provider: keyRow.provider as Parameters<typeof createLlmClient>[0]['provider'],
        model: agent.model,
        apiKey: plaintextKey || undefined,
        baseURL: keyRow.baseUrl ?? undefined,
      });
      trace('llm_client_from_key', {
        keyId: keyRow.id,
        provider: keyRow.provider,
      });
    } catch (err) {
      // Bad provider config in the DB row — fail loud (invariant 4).
      const errorCode = err instanceof Error ? err.message.slice(0, 200) : 'llm_key_invalid';
      await failJob(db, jobId as string, `llm_key_invalid:${errorCode}`, runStats());
      return { status: 'failed', error: `llm_key_invalid:${errorCode}` };
    }
  }

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
  // Build jobContext from job columns — the runner exposes data, the agent
  // personality decides what to do with it (invariant #1: data-driven behavior).
  // `agent_jobs.chat_id` carries the explicit Telegram-delivery intent: each
  // job-creation source (poller, sendTaskAction, cron tick) is responsible for
  // populating it when delivery is wanted. The runner does NOT fall back to
  // the agent's last-seen chat at execute time — that would override the
  // explicit "no Telegram" intent expressed by a NULL chat_id (e.g. dashboard
  // checkbox unticked).
  const jobContext: JobContext = {
    origin: job.channel ?? 'unknown',
    ...(job.chatId ? { telegramChatId: job.chatId } : {}),
  };

  let systemPrompt = job.systemPrompt;
  if (!systemPrompt) {
    systemPrompt = await buildSystemPrompt(agent, db, jobContext);
    await db
      .update(agentJobs)
      .set({ systemPrompt, updatedAt: new Date() })
      .where(eq(agentJobs.id, jobId as string));
  }

  // ── 7. Build tool set ─────────────────────────────────────────────────────────
  let toolDefs: AnyToolDef[];

  // Always-on built-ins (excluding return_result, which is handled per-branch
  // because orchestrators add it after their orchestration tools and workers
  // pull it via computeToolWhitelist's alwaysOn). The system prompt advertises
  // these to every agent — they MUST be in the runtime toolset too, otherwise
  // the LLM sees them in its prompt and trips AI_NoSuchToolError.
  const memoryBuiltins = ALWAYS_ON_TOOLS.filter((n) => n !== 'return_result')
    .map((n) => registry.get(n))
    .filter((t): t is AnyToolDef => t !== undefined);

  // Capability tools: computed from agent's configured integrations.
  // These are instantiated per-job and merged directly into toolDefs/toolMap.
  // CRITICAL: do NOT register into the shared registry — the registry is
  // process-scoped and shared across all concurrent jobs. Mutating it here
  // would leak the tool's availability to other agents that share the same
  // RunnerDeps instance, breaking invariant #9 (whitelist explicit per agent).
  // capabilityTools bypasses computeToolWhitelist's registry-based drift check
  // because the definition itself is passed, not just its name.
  const capabilityTools: AnyToolDef[] = [];
  if (agentRow.telegramBotToken) {
    capabilityTools.push(createTelegramSendMessageTool() as unknown as AnyToolDef);
  }

  try {
    if (isOrchestrator) {
      if (orchestratorMode === 'router') {
        const assignTools = (await generateAssignTools(agent.id, db)) as unknown as AnyToolDef[];
        const returnResult = registry.get('return_result');
        toolDefs = returnResult
          ? [...assignTools, ...memoryBuiltins, returnResult, ...capabilityTools]
          : [...assignTools, ...memoryBuiltins, ...capabilityTools];
      } else {
        const [createTaskTool, listTasksTool] = generateTaskTools(agent.id, db);
        const returnResult = registry.get('return_result');
        toolDefs = returnResult
          ? [
              createTaskTool as unknown as AnyToolDef,
              listTasksTool as unknown as AnyToolDef,
              ...memoryBuiltins,
              returnResult,
              ...capabilityTools,
            ]
          : [
              createTaskTool as unknown as AnyToolDef,
              listTasksTool as unknown as AnyToolDef,
              ...memoryBuiltins,
              ...capabilityTools,
            ];
      }
    } else {
      // Worker: whitelist from skill assignments + always-on tools + capability tools
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

      // ── Connector adapter tools ──────────────────────────────────────────────
      // Fetch agent's connector assignments (with per-operation whitelist).
      // Each assignment instantiates its adapter's tools using a bearer token
      // resolved from either:
      //   - connectors.credentialId → credentials.payload.accessToken (OAuth)
      //   - connectors.api_key      → decrypted api_key column (PAT / api_key)
      // null enabledOperations → all tools; array → whitelist on tool.name.
      // Adapters without a registry entry are skipped silently.
      const connectorAssignments = await db
        .select({
          connectorId: connectorsTable.id,
          slug: connectorsTable.slug,
          credentialId: connectorsTable.credentialId,
          apiKey: connectorsTable.apiKey,
          enabledOperations: agentConnectorAssignments.enabledOperations,
        })
        .from(agentConnectorAssignments)
        .innerJoin(connectorsTable, eq(connectorsTable.id, agentConnectorAssignments.connectorId))
        .where(eq(agentConnectorAssignments.agentId, agentRow.id));

      for (const ca of connectorAssignments) {
        const entry = ADAPTER_REGISTRY[ca.slug];
        if (!entry) continue; // no adapter for this catalog slug — skip silently

        let accessToken: string | null = null;
        if (entry.credentialType === 'api_key') {
          // PAT / api_key path: decrypt connectors.api_key directly.
          if (!ca.apiKey) continue;
          try {
            accessToken = decrypt(ca.apiKey);
          } catch {
            continue; // tampered / wrong master key — skip this connector silently
          }
        } else {
          // OAuth path: token lives in credentials.payload.accessToken.
          if (!ca.credentialId) continue;
          const decrypted = await getDecryptedCredentialById(db, ca.credentialId);
          if (!decrypted) continue;
          accessToken = decrypted.payload.accessToken;
        }

        if (!accessToken) continue;

        const allTools = entry.toolFactory(accessToken);
        const enabled = ca.enabledOperations;
        const filtered =
          enabled === null ? allTools : allTools.filter((t) => enabled.includes(t.name));

        capabilityTools.push(...filtered);
      }
      // ────────────────────────────────────────────────────────────────────────

      toolDefs = computeToolWhitelist(
        {
          agentId: agentRow.id,
          configuredTools: registeredConfigured,
          alwaysOn: [...ALWAYS_ON_TOOLS],
        },
        registry,
        capabilityTools,
      );
    }
  } catch (err) {
    const errorCode = err instanceof Error ? err.message : 'whitelist_computation_failed';
    await failJob(db, jobId as string, errorCode, runStats());
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
  let messages: ModelMessage[] = Array.isArray(job.messages)
    ? (job.messages as ModelMessage[])
    : [];

  if (messages.length === 0) {
    messages = [{ role: 'user', content: job.task }];
  }

  // ── 12. Main LLM loop ─────────────────────────────────────────────────────────
  try {
    while (true) {
      turn += 1;
      counters.resetTurnToolCalls();

      // Invariant 8: hard turn cap. `turn` is cumulative across resumes (it's
      // seeded from job.turn), so a job that loops — or resumes — without ever
      // calling return_result fails loud here instead of burning tokens until
      // the LLM provider's credit balance runs out. Matches Hermes Agent's
      // per-run iteration budget.
      if (turn > DEFAULT_LIMITS.maxTurns) {
        await failJob(db, jobId as string, 'turn_limit_exceeded', runStats());
        return { status: 'failed', error: 'turn_limit_exceeded' };
      }

      // a. Validate message structure
      validateMessageStructure(messages);

      // b. Tool choice
      const toolChoice = computeToolChoice({ isOrchestrator, turn, hasAdapterTools });

      // c. Convert tools to AI SDK format
      const aiSdkTools: Record<string, { description: string; inputSchema: z.ZodTypeAny }> = {};
      for (const [name, toolDef] of toolMap) {
        aiSdkTools[name] = { description: toolDef.description, inputSchema: toolDef.inputSchema };
      }

      // d. Call LLM
      trace('llm_call_start', { turn, msgCount: messages.length });
      const response = await llmClient.generateText({
        system: systemPrompt,
        messages,
        tools: aiSdkTools,
        toolChoice,
      });

      // Accumulate token usage. Some providers may return undefined/NaN for
      // either field — coerce to 0 so we never persist NaN. Local providers
      // (LM Studio, Ollama) sometimes omit usage entirely; that just means
      // those turns won't add to the total, not that the call failed.
      // AI SDK v6 renamed usage fields: promptTokens → inputTokens,
      // completionTokens → outputTokens. Both can be `undefined` when the
      // provider doesn't report usage (local providers like LM Studio /
      // Ollama sometimes omit it) — Number(undefined) is NaN, hence the
      // isFinite guard below.
      const usage = response.usage;
      const promptT = Number(usage?.inputTokens ?? 0);
      const completionT = Number(usage?.outputTokens ?? 0);
      inputTokens += Number.isFinite(promptT) ? promptT : 0;
      outputTokens += Number.isFinite(completionT) ? completionT : 0;

      const rawToolCalls = response.toolCalls ?? [];
      trace('llm_call_done', {
        turn,
        toolCalls: rawToolCalls.map((tc) => tc.toolName),
        textLen: (response.text ?? '').length,
        usage: { in: promptT, out: completionT },
      });

      // e. Append assistant message (use text or build from tool calls)
      const assistantMsg: ModelMessage = {
        role: 'assistant',
        content:
          rawToolCalls.length > 0
            ? rawToolCalls.map((tc) => ({
                type: 'tool-call' as const,
                toolCallId: tc.toolCallId,
                toolName: tc.toolName,
                input: tc.input as Record<string, unknown>,
              }))
            : response.text || '',
      };
      messages = [...messages, assistantMsg];

      // f. Note return_result presence — but do NOT short-circuit. If the LLM
      // returns it alongside other tools (e.g. [create_task, return_result]),
      // we must execute the others first. Finalization happens at step (j+).
      const returnResultCall = rawToolCalls.find((tc) => tc.toolName === 'return_result');

      // g. No tool calls
      if (rawToolCalls.length === 0) {
        trace('no_tool_calls_branch', { turn, hasText: Boolean(response.text) });
        const textContent = response.text ?? '';
        if (textContent) {
          await completeJob(db, jobId as string, textContent, toolsUsed, runStats(), messages);
          return { status: 'completed', result: textContent };
        }
        // No text, no tool calls — fail loud (invariant 4)
        await failJob(db, jobId as string, 'no_tool_calls_no_text', runStats());
        return { status: 'failed', error: 'no_tool_calls_no_text' };
      }

      // h. Filter delegation calls to one-per-turn
      const rawCallBlocks = rawToolCalls.map((tc) => ({
        type: 'tool_use' as const,
        id: tc.toolCallId,
        name: tc.toolName,
        input: tc.input as Record<string, unknown>,
      }));

      const {
        kept: keptAssign,
        dropped: droppedAssign,
        others,
      } = filterToolCallsForDelegation(rawCallBlocks);
      const sideToolResults = buildDeferredToolResults(droppedAssign);
      // Strip return_result from the for-loop processing — it's handled
      // separately after the loop so we can execute siblings (e.g. create_task)
      // before finalizing. Without this, an LLM that emits both in one turn
      // would have its real work discarded.
      const othersWithoutReturn = others.filter((b) => b.name !== 'return_result');
      // Order matters: non-assign tool calls (save_memory, query_memory, etc.)
      // run FIRST, then the assign call. If the assign triggers delegation,
      // the loop exits via recursive executeJob — anything queued AFTER would
      // be silently dropped, leaving the LLM's tool_use blocks unmatched at
      // resume time (unmatched_tool_use error). Their results are forwarded to
      // handleDelegation as sideToolResults so resumeDelegated re-injects them.
      const callsToProcess = keptAssign
        ? [...othersWithoutReturn, keptAssign]
        : othersWithoutReturn;

      // i. Process tool calls. AI SDK v6 ToolResultPart shape:
      //   { type: 'tool-result', toolCallId, toolName, output: ToolResultOutput }
      // where ToolResultOutput is a discriminated union — we use 'text' for
      // plain string outputs and 'json' for structured ones.
      type ToolResultOutput = { type: 'text'; value: string } | { type: 'json'; value: unknown };
      const toolResultBlocks: Array<{
        type: 'tool-result';
        toolCallId: string;
        toolName: string;
        output: ToolResultOutput;
      }> = [];
      // Coerce a tool's raw return value to a JSON-safe representation. Tools
      // can return Date objects, undefined fields, etc. — none of which match
      // AI SDK v6's JSONValue Zod schema (it expects only null/bool/number/
      // string/array/object). `JSON.parse(JSON.stringify(...))` does the
      // canonical coercion: Date → ISO string, undefined fields dropped,
      // anything not serializable surfaces as an explicit JSON.stringify
      // error which we'd rather see loudly than silently mangle. Caught live
      // post-v6 bump: query_memory returned rows with `created_at: Date`
      // which made the Zod ModelMessage[] validation reject the next prompt.
      const toResultOutput = (raw: unknown): ToolResultOutput => {
        if (typeof raw === 'string') return { type: 'text', value: truncateForContext(raw) };
        const json: unknown = JSON.parse(JSON.stringify(raw ?? null));
        const serialized = JSON.stringify(json);
        if (serialized.length <= MAX_TOOL_RESULT_CHARS) return { type: 'json', value: json };
        // Oversized structured result — return a truncated text rendering. A
        // truncated JSON string would not parse, so we switch to the 'text'
        // variant of the discriminated union to keep the message well-formed.
        return { type: 'text', value: truncateForContext(serialized) };
      };

      let awaitingApproval = false;

      for (const call of callsToProcess) {
        counters.bumpToolCall();
        toolsUsed = [...new Set([...toolsUsed, call.name])];

        const toolDef = toolMap.get(call.name);
        if (!toolDef) {
          await failJob(db, jobId as string, `whitelist_violation:${call.name}`, runStats());
          return { status: 'failed', error: `whitelist_violation:${call.name}` };
        }

        if (call.name.startsWith('assign_')) {
          const childSlug = call.name.replace(/^assign_/, '').replace(/_/g, '-');

          try {
            await executeTool(
              toolDef,
              call.input,
              {
                jobId: jobId as string,
                agentId: agentRow.id,
                entityId: job.entityId ?? '',
                db,
                jobChatId: job.chatId ?? null,
                embeddingClient: deps.embeddingClient,
                workspaceRootPath: agentRow.workspaceRootPath ?? null,
              },
              { approvalRules: approvalRuleList, onApprovalRequired: async () => {} },
            );
          } catch (err) {
            if (err instanceof DelegationPendingError) {
              counters.bumpDelegationDepth();

              // Track the assign_* call in toolsUsed BEFORE persisting — without
              // this the parent loses its turn-1 tool list across the suspend.
              toolsUsed = [...new Set([...toolsUsed, call.name])];

              // Persist run-state (turn, tokens, toolsUsed) before transitioning
              // to awaiting_delegation. handleDelegation persists messages +
              // status atomically; this complements it for observability.
              await saveCheckpoint(db, jobId as string, {
                messages,
                turn,
                chainCount: job.chainCount ?? 0,
                toolsUsed,
                inputTokens,
                outputTokens,
              });

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

              // Forward any non-assign tool results we already executed in this
              // turn (e.g. save_memory ran before the assign) as additional
              // sideToolResults. Without this, the LLM's earlier tool_use
              // blocks have no matching tool_result on resume → unmatched_tool_use.
              const preAssignSideResults = toolResultBlocks.map((b) => ({
                type: 'tool_result' as const,
                tool_use_id: b.toolCallId,
                toolName: b.toolName,
                content:
                  b.output.type === 'text'
                    ? b.output.value
                    : JSON.stringify(b.output.value ?? null),
              }));

              const delegation = await handleDelegation(
                jobShape,
                childSlug,
                call.id,
                {
                  task: (call.input['task'] as string) ?? '',
                  data: call.input['data'] as string | undefined,
                  chatId: job.chatId,
                },
                [...sideToolResults, ...preAssignSideResults],
                db,
              );

              // Drive the child synchronously, then resume the parent. In
              // single-process local mode this is the simplest correct flow:
              // no queue, no orphaned children, no separate delivery cron.
              // The recursion is bounded by DelegationDepthExceededError
              // (max 3) thrown from bumpDelegationDepth above.
              const childOutcome = await executeJob(delegation.childJobId, deps, _runnerEnv);

              if (childOutcome.status === 'failed') {
                const childErr = childOutcome.error || 'unknown';
                await failJob(db, jobId as string, `child_failed:${childErr}`, runStats());
                return { status: 'failed', error: `child_failed:${childErr}` };
              }

              if (childOutcome.status !== 'completed') {
                // Child suspended (awaiting approval / its own delegation /
                // already_handled). For a smoke-quality flow we treat this as
                // a failure on the parent; a fuller resume mechanism (poll +
                // re-trigger) would be needed to support nested suspensions.
                await failJob(
                  db,
                  jobId as string,
                  `child_suspended:${childOutcome.status}`,
                  runStats(),
                );
                return {
                  status: 'failed',
                  error: `child_suspended:${childOutcome.status}`,
                };
              }

              // Inject child's result as tool_result on the parent and flip
              // status back to 'pending' so we can re-enter executeJob.
              await resumeDelegated(jobId as JobId, delegation.childJobId, childOutcome.result, db);

              return executeJob(jobId, deps, _runnerEnv);
            }
            throw err;
          }

          continue;
        }

        // Non-delegation tool
        const toolResult = await executeTool(
          toolDef,
          call.input,
          {
            jobId: jobId as string,
            agentId: agentRow.id,
            entityId: job.entityId ?? '',
            db,
            jobChatId: job.chatId ?? null,
            embeddingClient: deps.embeddingClient,
            workspaceRootPath: agentRow.workspaceRootPath ?? null,
          },
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
            output: toResultOutput(awaitingMarker),
          });
          awaitingApproval = true;
          break;
        }

        toolResultBlocks.push({
          type: 'tool-result',
          toolCallId: call.id,
          toolName: call.name,
          output: toResultOutput(
            toolResult.outcome === 'success' ? toolResult.output : { error: toolResult.error },
          ),
        });
      }

      // j. Suspension states
      if (awaitingApproval) {
        if (toolResultBlocks.length > 0) {
          messages = [...messages, { role: 'tool', content: toolResultBlocks } as ModelMessage];
        }
        await saveCheckpoint(db, jobId as string, {
          messages,
          turn,
          chainCount: job.chainCount ?? 0,
          toolsUsed,
          inputTokens,
          outputTokens,
        });
        await setJobStatus(db, jobId as string, 'awaiting_approval');
        return { status: 'awaiting_approval' };
      }

      // j-pré. Detect tool errors in the same turn as return_result. If a
      // sibling tool errored, do NOT finalize: inject the error into messages
      // and re-loop so the LLM sees it next turn. Without this guard, a turn
      // like [telegram_send_message (error), return_result] would silently
      // finalize the job claiming success even though the side-effect failed
      // — direct violation of invariant #4 (no silent fallbacks).
      // A "sibling tool error" is one whose tool_result output is a JSON
      // object containing an `error` field (the shape we wrap failures in
      // — see toResultOutput callers in section i above).
      const isToolErrorBlock = (block: (typeof toolResultBlocks)[number]): boolean =>
        block.toolName !== 'return_result' &&
        block.output.type === 'json' &&
        block.output.value !== null &&
        typeof block.output.value === 'object' &&
        'error' in (block.output.value as Record<string, unknown>);

      const turnHadSiblingToolError =
        returnResultCall !== undefined && toolResultBlocks.some(isToolErrorBlock);

      if (returnResultCall && turnHadSiblingToolError) {
        const erroredTools = toolResultBlocks.filter(isToolErrorBlock).map((b) => b.toolName);
        trace('return_result_skipped_due_to_tool_error', { turn, erroredTools });

        // Synthesize a tool-result for return_result so the message-structure
        // invariant holds (every tool_use must have a matching tool_result).
        // The LLM gets to see both the sibling errors AND a "deferred" marker
        // for return_result, then chooses whether to retry the failed tool or
        // call return_result again with status='blocked'.
        toolResultBlocks.push({
          type: 'tool-result',
          toolCallId: returnResultCall.toolCallId,
          toolName: 'return_result',
          output: toResultOutput({ error: 'deferred: sibling tool error must be addressed first' }),
        });
        messages = [...messages, { role: 'tool', content: toolResultBlocks } as ModelMessage];
        continue;
      }

      // j-bis. return_result finalization — runs AFTER all sibling tools have
      // executed, so a turn like [create_task, return_result] still creates the
      // task before completing. The synthetic tool-result for return_result is
      // appended alongside other tool-results to satisfy the message-structure
      // invariant (every tool_use has a matching tool_result).
      if (returnResultCall) {
        trace('return_result_branch', { turn });
        // Brique 33: return_result is status-only. Content delivery happens via
        // dashboard_publish, telegram_send_message, etc. — those tools already
        // wrote to agent_jobs.result (or a delivery channel) via their side-effects.
        // We pass empty finalResult; completeJob preserves existing result.
        const finalResult = '';
        toolsUsed = [...new Set([...toolsUsed, 'return_result'])];

        toolResultBlocks.push({
          type: 'tool-result',
          toolCallId: returnResultCall.toolCallId,
          toolName: 'return_result',
          output: toResultOutput({ acknowledged: true }),
        });
        messages = [...messages, { role: 'tool', content: toolResultBlocks } as ModelMessage];

        // If this run created tasks on the board, the workflow continues
        // asynchronously: the cron's executeReadyTasks runs each task and
        // deliverCompletedRoots compiles + finalizes the parent once all tasks
        // are done. Calling completeJob here would set completedAt and lock
        // out the cron's delivery (it gates on `completedAt IS NULL`), so the
        // user would never see the compiled task results — only the
        // orchestrator's summary. Instead, save a checkpoint and let the cron
        // own the final state. Status stays 'processing' until the cron flips
        // it to 'completed'.
        const taskRows = await db
          .select({ id: agentTasks.id })
          .from(agentTasks)
          .where(eq(agentTasks.rootJobId, jobId as string));

        if (taskRows.length > 0) {
          trace('return_result_with_tasks', { taskCount: taskRows.length });
          await saveCheckpoint(db, jobId as string, {
            messages,
            turn,
            chainCount: job.chainCount ?? 0,
            toolsUsed,
            inputTokens,
            outputTokens,
            totalDurationMs: Date.now() - startedAt,
          });
          return { status: 'awaiting_tasks' };
        }

        trace('completeJob_call', { turn, toolsUsed, stats: runStats() });
        await completeJob(db, jobId as string, finalResult, toolsUsed, runStats(), messages);

        // Re-fetch agent_jobs.result so the caller (the parent in a router
        // delegation flow) receives the text written by dashboard_publish /
        // telegram_send_message side-effects earlier in this turn. Without
        // this, ExecuteJobResult.result was always '' and resumeDelegated
        // injected an empty tool-result into the parent, leaving the parent
        // orchestrator blind to what the sub-agent actually produced (and
        // forcing it to hallucinate or re-delegate until chain limit).
        const [finalRow] = await db
          .select({ result: agentJobs.result })
          .from(agentJobs)
          .where(eq(agentJobs.id, jobId as string))
          .limit(1);
        const propagatedResult = finalRow?.result ?? '';

        trace('exit_completed_via_return_result', {
          propagatedResultLen: propagatedResult.length,
        });
        return { status: 'completed', result: propagatedResult };
      }

      // k. Append tool results and continue
      if (toolResultBlocks.length > 0) {
        messages = [...messages, { role: 'tool', content: toolResultBlocks } as ModelMessage];
      }
    }
  } catch (err) {
    trace('catch', {
      errName: err instanceof Error ? err.name : 'unknown',
      errMsg: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    // Typed errors — error codes only (invariant 2)
    if (err instanceof ToolCallLimitExceededError) {
      await failJob(db, jobId as string, err.code, runStats());
      return { status: 'failed', error: err.code };
    }

    if (err instanceof ChainLimitExceededError) {
      await failJob(db, jobId as string, err.code, runStats());
      return { status: 'failed', error: err.code };
    }

    if (err instanceof DelegationDepthExceededError) {
      await failJob(db, jobId as string, err.code, runStats());
      return { status: 'failed', error: err.code };
    }

    if (err instanceof QuotaExhaustedError) {
      await failJob(db, jobId as string, 'quota_exhausted', runStats());
      return { status: 'failed', error: 'quota_exhausted' };
    }

    if (err instanceof MessageStructureError) {
      await failJob(db, jobId as string, `message_structure_invalid:${err.code}`, runStats());
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
        await failJob(db, jobId as string, code, runStats());
        return { status: 'failed', error: code };
      }
    }

    // Invariant 3: never catch agent-specific exceptions. All errors fail loud.
    const errorCode = err instanceof Error ? err.message.slice(0, 200) : 'unknown_error';
    await failJob(db, jobId as string, errorCode, runStats());
    return { status: 'failed', error: errorCode };
  }
}
