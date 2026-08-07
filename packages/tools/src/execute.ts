// @nodal-agents/tools — execution wrapper with approval gate and audit trail

import { approvalRequests, toolCalls } from '@nodal-agents/db';
import { MessageStructureError, QuotaExhaustedError } from '@nodal-agents/llm';
import {
  redactSecretsForAudit,
  isCatastrophicCommand,
  isDestructiveOrHeavyCommand,
} from '@nodal-agents/shared';
import type { z } from 'zod';
import type {
  ToolDefinition,
  ToolContext,
  ExecuteOptions,
  ToolExecutionResult,
  ApprovalGateRequest,
} from './types';
import { InvalidInputError } from './errors';

// ─── executeTool ──────────────────────────────────────────────────────────────

/**
 * Execute a registered tool with:
 *   1. Input validation (Zod)
 *   2. Approval gate check (against rules from DB)
 *   3. Tool execution
 *   4. Audit trail write (tool_calls row, always)
 *
 * IMPORTANT: MessageStructureError and QuotaExhaustedError are re-thrown
 * unconditionally — the runner must handle them to fail the job loud.
 *
 * The approval gate:
 *   - rule action 'require_approval' → insert approval_requests row, call
 *     onApprovalRequired, return { outcome: 'awaiting_approval' }.
 *   - rule action 'block' → return { outcome: 'error', error: 'blocked' }.
 *   - rule action 'auto_approve' → execute normally.
 *   - no matching rule → fall back to the tool's `defaultApproval`: execute for
 *     ordinary tools, or suspend for approval for safe-by-default tools
 *     (run_command). A per-agent auto_approve rule overrides this ("Yolo").
 *   - still no gate → fall back to the tool's `computeApproval` hook, if it
 *     declares one: a PER-CALL check (e.g. file_write/file_edit gating only
 *     an overwrite of an existing file in the shared workspace, D1).
 *
 * Rule matching: tool-specific rules take precedence over wildcard.
 * Agent-scoped rules take precedence over entity-scoped rules.
 * If multiple rules match, the most specific one wins (agent+tool > entity+tool).
 */
export async function executeTool<TInput extends z.ZodTypeAny, TOutput>(
  tool: ToolDefinition<TInput, TOutput>,
  rawInput: unknown,
  ctx: ToolContext,
  opts: ExecuteOptions,
): Promise<ToolExecutionResult> {
  const startMs = Date.now();

  // ── 1. Input validation ────────────────────────────────────────────────────
  const parsed = tool.inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const detail = parsed.error.message;
    const result: ToolExecutionResult = {
      outcome: 'error',
      error: `invalid_input: ${detail}`,
    };
    // Still write audit row for failed validations
    await _writeToolCall(ctx, tool.name, rawInput, JSON.stringify(result), Date.now() - startMs);
    return result;
  }

  const validatedInput = parsed.data as z.infer<typeof tool.inputSchema>;

  // ── 2. Approval gate ───────────────────────────────────────────────────────
  const matchedRule = matchApprovalRule(opts.approvalRules, tool.name, ctx.agentId, ctx.entityId);
  // An explicit rule always wins. With no matching rule, fall back to the tool's
  // own default posture: undefined for ordinary tools (→ execute, the historical
  // default), 'require_approval' for safe-by-default tools like run_command. So a
  // per-agent `auto_approve` rule (the "Yolo" toggle) is exactly what lets
  // run_command run without a human in the loop.
  let effectiveAction = matchedRule?.action ?? tool.defaultApproval;

  // ── Autonomy-based relaxation ────────────────────────────────────────────────
  // The owner's ROOT autonomy level can relax the safe-by-default require_approval
  // posture. Guarded by `!matchedRule` so any EXPLICIT rule still wins (a user-set
  // require_approval, and crucially the run_command LAN master-switch's injected
  // require_approval). The catastrophic hardline floor below still re-forces a human.
  //   - fully_autonomous → auto-approve everything;
  //   - destructive_gate → auto-approve ordinary work, but KEEP the gate for a
  //     `destructive` tool or a destructive/heavy run_command (rm, install, kill…).
  if (!matchedRule && effectiveAction === 'require_approval') {
    if (opts.autonomy === 'fully_autonomous') {
      effectiveAction = 'auto_approve';
    } else if (opts.autonomy === 'destructive_gate') {
      // What still needs a human under "auto, gate destructive":
      //  - run_command → only when the command ITSELF is destructive/heavy
      //    (rm, install, download, kill, disk…); ordinary commands auto-run.
      //  - run_skill_script → the script's CONTENT is opaque to us (it's not
      //    inspectable like a shell command string), so it stays gated — falls
      //    through to the riskLevel check below, and it declares 'destructive'.
      //  - any other tool → gate when its declared riskLevel is 'destructive'
      //    (e.g. a connector delete). NOTE run_command declares riskLevel
      //    'destructive' as a blanket safe-by-default, so it must be judged by
      //    the command rule, NOT that blanket level — otherwise destructive_gate
      //    would gate every shell command (the bug).
      const command = String((validatedInput as { command?: unknown })?.command ?? '');
      const mcpTransport = String((validatedInput as { transport?: unknown })?.transport ?? '');
      let isHeavy: boolean;
      if (tool.name === 'run_command') isHeavy = isDestructiveOrHeavyCommand(command);
      // É-2 (audit sécu 2026-07-07): create_mcp with a stdio transport spawns an
      // arbitrary local subprocess (npx/uvx <cmd>) — RCE-equivalent to
      // run_command — so it must stay gated under destructive_gate. Its declared
      // riskLevel is 'write' (correct for the http case), which would otherwise
      // let this stdio spawn auto-approve. The http case keeps the 'write' path.
      else if (tool.name === 'create_mcp' && mcpTransport === 'stdio') isHeavy = true;
      // MCP-001 (audit 2026-08-07): a tool from a third-party MCP server is
      // foreign code, not "ordinary work", so `destructive_gate` must keep its
      // gate on it. Judging it by riskLevel does not work — that value is
      // derived from annotations the SERVER supplies, i.e. the attacker's own
      // claim about itself (a `purge_all_data` tool declaring
      // `readOnlyHint: true` was measured resolving to riskLevel 'read').
      // `__` is the MCP namespace marker: builtin and connector tools are bare
      // snake_case, only `<slug>__<tool>` carries it — the same invariant
      // lint-skill-content.ts relies on.
      else if (tool.name.includes('__')) isHeavy = true;
      else isHeavy = tool.riskLevel === 'destructive';
      if (!isHeavy) effectiveAction = 'auto_approve';
    }
  }

  // ── Per-call dynamic gate (D1) ─────────────────────────────────────────────
  // Complements the static defaultApproval fallback above: a tool declaring
  // `computeApproval` decides, PER CALL, whether THIS specific input is
  // destructive enough to need a human — e.g. file_write/file_edit only when
  // overwriting an existing file in the shared workspace. Same precedence as
  // defaultApproval: an explicit rule always wins (guarded by !matchedRule),
  // and fully_autonomous drops the gate entirely (no hardline floor here —
  // unlike run_command's catastrophic-command circuit breaker, nothing in
  // this hook's scope is dangerous enough to warrant overriding Yolo).
  if (
    !matchedRule &&
    effectiveAction !== 'block' &&
    effectiveAction !== 'require_approval' &&
    tool.computeApproval &&
    opts.autonomy !== 'fully_autonomous'
  ) {
    const dynamic = await tool.computeApproval(validatedInput, ctx);
    if (dynamic === 'require_approval') effectiveAction = 'require_approval';
  }

  // ── Hardline floor ─────────────────────────────────────────────────────────
  // A catastrophic, machine-wide-destructive shell command can NEVER be
  // auto-approved — not even under Yolo. Force a human decision regardless of
  // any auto_approve rule, so an LLM slip or a malicious skill can't wipe the
  // disk silently. (Last-resort circuit breaker, narrow by design.)
  // The catastrophic floor now INCLUDES inline interpreter-eval (`python -c`,
  // `node -e`, …): an opaque payload can smuggle any destruction, so it is
  // forced to a human here and refused even after approval on the resume path
  // (owner's decision, A2). No separate softer tier.
  if (
    tool.name === 'run_command' &&
    effectiveAction !== 'block' &&
    effectiveAction !== 'require_approval' &&
    isCatastrophicCommand(String((validatedInput as { command?: unknown })?.command ?? ''))
  ) {
    effectiveAction = 'require_approval';
  }

  // Second hardline floor: `create_mcp` with a STDIO transport (audit
  // 2026-08-07). É-2 already judged this RCE-equivalent to run_command and gated
  // it under `destructive_gate` (line ~112 above) — but that branch is only
  // reached when `effectiveAction` is still 'require_approval', and
  // `fully_autonomous` flips it to 'auto_approve' first. So the stdio gate
  // existed in the middle tier and vanished in the top one, which is the
  // opposite of what a hardline floor means.
  //
  // Scope is deliberately stdio-only: an `http` server spawns nothing locally,
  // and É-2's decision to let it auto-approve under `destructive_gate` still
  // holds — more so now that every tool such a server exposes carries
  // `defaultApproval: 'require_approval'` of its own (MCP-001), so attaching one
  // no longer hands the model anything it can run unattended.
  if (
    tool.name === 'create_mcp' &&
    effectiveAction !== 'block' &&
    effectiveAction !== 'require_approval' &&
    String((validatedInput as { transport?: unknown })?.transport ?? '') === 'stdio'
  ) {
    effectiveAction = 'require_approval';
  }

  if (effectiveAction === 'block') {
    const result: ToolExecutionResult = { outcome: 'error', error: 'blocked' };
    await _writeToolCall(
      ctx,
      tool.name,
      validatedInput,
      JSON.stringify(result),
      Date.now() - startMs,
    );
    return result;
  }

  if (effectiveAction === 'require_approval') {
    // Insert approval_requests row
    const [row] = await ctx.db
      .insert(approvalRequests)
      .values({
        entityId: ctx.entityId,
        jobId: ctx.jobId,
        agentId: ctx.agentId,
        toolName: tool.name,
        // NOUVEAU-1: unlike tool_calls, this column is NOT redacted at rest —
        // the approval re-exec path (apps/runner/src/job/execute.ts) reads it
        // back verbatim to re-run the approved call, so a redacted apiKey here
        // would store '***' as the real secret. Instead, every DISPLAY of this
        // row is redacted at load (web approvals loader + Telegram notify).
        // Encrypting the secret fields at rest here (and decrypting on re-exec)
        // is the tracked follow-up.
        toolInput: validatedInput as Record<string, unknown>,
        status: 'pending',
      })
      .returning();

    if (!row) {
      // Fallthrough — fail loud
      const result: ToolExecutionResult = { outcome: 'error', error: 'approval_insert_failed' };
      await _writeToolCall(
        ctx,
        tool.name,
        validatedInput,
        JSON.stringify(result),
        Date.now() - startMs,
      );
      return result;
    }

    const gateRequest: ApprovalGateRequest = {
      approvalRequestId: row.id,
      toolName: tool.name,
      toolInput: validatedInput,
      jobId: ctx.jobId,
      agentId: ctx.agentId,
      entityId: ctx.entityId,
    };

    await opts.onApprovalRequired(gateRequest);

    const approvalResult: ToolExecutionResult = {
      outcome: 'awaiting_approval',
      approvalRequestId: row.id,
    };
    await _writeToolCall(
      ctx,
      tool.name,
      validatedInput,
      JSON.stringify(approvalResult),
      Date.now() - startMs,
    );
    return approvalResult;
  }

  // ── 3. Execute ─────────────────────────────────────────────────────────────
  try {
    const output = await tool.execute(validatedInput, ctx);
    const durationMs = Date.now() - startMs;
    await _writeToolCall(ctx, tool.name, validatedInput, JSON.stringify(output), durationMs);
    return { outcome: 'success', output };
  } catch (err) {
    // Re-throw fatal runner errors — never swallow these
    if (err instanceof MessageStructureError || err instanceof QuotaExhaustedError) {
      throw err;
    }

    // Re-throw delegation signal — assign_* tools throw DelegationPendingError
    // as a control-flow primitive: the runner catches it to suspend the parent
    // job and create the child. Swallowing it would convert the signal into a
    // tool error and leave the assistant message with an unresolved tool_call.
    // Detected by name (not instanceof) because @nodal-agents/tools must not depend
    // on @nodal-agents/orchestration (which depends on us — would be a cycle).
    if (err instanceof Error && err.name === 'DelegationPendingError') {
      throw err;
    }

    const errorMsg = err instanceof Error ? err.message : String(err);
    // Send-timeout ambiguity (DeliveryError.mayHaveDelivered): the message may
    // have reached the user even though the API answered late. Keep outcome
    // 'error' (nothing is confirmed) but flag it and spell out the one rule
    // that matters to the LLM: do NOT resend.
    const mayHaveDelivered =
      err instanceof Error && (err as { mayHaveDelivered?: boolean }).mayHaveDelivered === true;
    const result: ToolExecutionResult = mayHaveDelivered
      ? {
          outcome: 'error',
          error:
            `${errorMsg} — AMBIGUOUS OUTCOME: the send request WAS transmitted and the ` +
            'message may have been delivered. Do NOT call this tool again with the same ' +
            'content (resending duplicates messages). Continue as if delivered and mention ' +
            'the uncertainty in your final result.',
          mayHaveDelivered: true,
        }
      : { outcome: 'error', error: errorMsg };
    await _writeToolCall(
      ctx,
      tool.name,
      validatedInput,
      JSON.stringify(result),
      Date.now() - startMs,
    );
    return result;
  }
}

// ─── Approval rule matcher ────────────────────────────────────────────────────

/**
 * The MCP server namespace of a tool name, or null for a built-in.
 *
 * `<serverPrefix>__<tool>` is the MCP naming convention; nothing else in the
 * product puts `__` in a tool name (builtins and connector tools are bare
 * snake_case — the same invariant lint-skill-content.ts relies on).
 */
export function namespaceOf(toolName: string): string | null {
  const i = toolName.indexOf('__');
  return i > 0 ? toolName.slice(0, i) : null;
}

/** The rule pattern that covers every tool of one MCP server. */
export function namespaceRulePattern(serverPrefix: string): string {
  return `${serverPrefix}__*`;
}

/**
 * Find the most specific matching approval rule.
 * Specificity: agent-scoped + tool-name > entity-scoped + tool-name > wildcard.
 * Returns undefined if no rule matches (default: execute without approval).
 *
 * Exported so callers can pre-check whether a tool call WOULD be gated before
 * calling executeTool — e.g. the runner's parallel read pre-pass (execute.ts
 * in apps/runner) uses this to keep any call that would land on
 * 'require_approval' out of the concurrent batch, so at most one
 * approval_requests row is created per turn (see audit finding RT-3 / #17).
 */
export function matchApprovalRule(
  rules: ExecuteOptions['approvalRules'],
  toolName: string,
  agentId: string,
  entityId: string,
): ExecuteOptions['approvalRules'][number] | undefined {
  // Priority 1: agent-scoped rule for this exact tool
  const agentToolRule = rules.find((r) => r.toolName === toolName && r.agentId === agentId);
  if (agentToolRule) return agentToolRule;

  // Priority 2: entity-scoped rule for this exact tool (no agent filter)
  const entityToolRule = rules.find(
    (r) => r.toolName === toolName && r.agentId === null && r.entityId === entityId,
  );
  if (entityToolRule) return entityToolRule;

  // Priority 3 & 4: NAMESPACE rules — `<serverPrefix>__*`, covering every tool
  // one MCP server exposes.
  //
  // Without this, consenting to a server means creating one rule per tool: the
  // a single server commonly exposes 30 tools, so one "I trust this server"
  // decision turned into 30 identical rows. The owner has already made that
  // decision once, when they attached the server — asking them to re-express it
  // thirty times is how a gate becomes a rubber stamp.
  //
  // `__` is the MCP namespace marker (builtin and connector tools are bare
  // snake_case), so a namespace rule can never accidentally cover a built-in.
  // Deliberately BELOW exact-tool rules: a per-tool `require_approval` or
  // `block` still overrides a per-server `auto_approve`.
  const namespace = namespaceOf(toolName);
  if (namespace) {
    const pattern = `${namespace}__*`;
    const agentNs = rules.find((r) => r.toolName === pattern && r.agentId === agentId);
    if (agentNs) return agentNs;
    const entityNs = rules.find(
      (r) => r.toolName === pattern && r.agentId === null && r.entityId === entityId,
    );
    if (entityNs) return entityNs;
  }

  // Priority 5: agent-scoped wildcard (toolName = '*')
  const agentWild = rules.find((r) => r.toolName === '*' && r.agentId === agentId);
  if (agentWild) return agentWild;

  // Priority 6: entity-scoped wildcard
  const entityWild = rules.find(
    (r) => r.toolName === '*' && r.agentId === null && r.entityId === entityId,
  );
  return entityWild;
}

// ─── Audit trail writer ───────────────────────────────────────────────────────

async function _writeToolCall(
  ctx: ToolContext,
  toolName: string,
  input: unknown,
  output: string,
  durationMs: number,
): Promise<void> {
  try {
    await ctx.db.insert(toolCalls).values({
      entityId: ctx.entityId,
      jobId: ctx.jobId,
      toolName,
      // NOUVEAU-1: the audit trail is never re-executed, so we store a
      // secret-redacted copy — create_connector/create_mcp API keys and stdio
      // env values must not sit in cleartext in tool_calls or render to the
      // logs dashboard (LogsTable). The real value already reached the tool's
      // execute() above; only this copy is masked.
      toolInput: redactSecretsForAudit(input) as Record<string, unknown>,
      toolOutput: output,
      durationMs,
    });
  } catch {
    // Audit write failure must never crash the tool execution path.
    // The runner can detect missing audit rows via monitoring, not via exceptions.
  }
}

// Re-export error for downstream convenience
export { InvalidInputError };
