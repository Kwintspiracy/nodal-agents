// @nodal-agents/tools — execution wrapper with approval gate and audit trail

import { approvalRequests, toolCalls } from '@nodal-agents/db';
import { MessageStructureError, QuotaExhaustedError } from '@nodal-agents/llm';
import {
  redactSecretsForAudit,
  isCatastrophicCommand,
  isDestructiveOrHeavyCommand,
  surfaceForTool,
  type MutationTarget,
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
import { presentToolResult } from './cards';
import type { ToolCardPayload } from '@nodal-agents/shared';
import { snapshot } from '@nodal-agents/checkpoints';
import { stat } from 'node:fs/promises';
import { writeMutationIntent } from './verification/intent';
import { attachProductionToProject } from './projects/attach';

// ─── Outils d'exécution de code ───────────────────────────────────────────────

/**
 * Les outils qui font tourner du code arbitraire sur la machine de l'hôte —
 * shell, harnais de code, scripts de skill, écriture dans un bundle de skill,
 * et le spawn d'un serveur MCP stdio.
 *
 * Ils partagent une propriété : leur exécution ne peut PAS être déduite d'une
 * préférence générale. Le niveau d'autonomie du workspace
 * (`fully_autonomous` / `destructive_gate`) dit à quel point l'utilisateur
 * veut être dérangé pour du travail ordinaire ; il ne dit rien sur le fait de
 * confier un shell à un agent. Ce consentement-là s'exprime uniquement par
 * une règle d'approbation explicite (le toggle Yolo par agent).
 *
 * Cette liste est LA source unique (revue sécurité du 25/08) : le frein
 * d'urgence du runner l'importait en double sous forme de tableau inline.
 * Deux copies identiques ce jour-là, rien ne verrouillait l'égalité — un
 * futur outil ajouté ici mais pas là-bas aurait laissé une règle wildcard
 * `*` le balayer malgré le bouton rouge. Un seul endroit, donc.
 */
export const CODE_EXECUTION_TOOL_NAMES: readonly string[] = [
  'run_command',
  'code_task',
  'run_skill_script',
  'skill_file_write',
  'create_mcp',
  'attach_mcp',
];

const CODE_EXECUTION_TOOL_SET = new Set(CODE_EXECUTION_TOOL_NAMES);

export function isCodeExecutionTool(toolName: string): boolean {
  return CODE_EXECUTION_TOOL_SET.has(toolName);
}

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
  // The audit row reads the tool's card and presenter; the generic parameters
  // are erased the same way the registry erases them (see registry.ts).
  const auditTool = tool as unknown as ToolDefinition<z.ZodTypeAny, unknown>;

  // ── 1. Input validation ────────────────────────────────────────────────────
  const parsed = tool.inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const detail = parsed.error.message;
    const result: ToolExecutionResult = {
      outcome: 'error',
      error: `invalid_input: ${detail}`,
    };
    // Still write audit row for failed validations
    await _writeToolCall(ctx, auditTool, rawInput, JSON.stringify(result), Date.now() - startMs);
    return result;
  }

  const validatedInput = parsed.data as z.infer<typeof tool.inputSchema>;

  // ── 1.4 An explicit `block` rule wins over everything ──────────────────────
  // Resolved here, ahead of preflight, and this order was argued for rather
  // than assumed (PR #6 review nº2). Three reasons:
  //
  //   - `block` is the owner's explicit decision; a capability diagnosis must
  //     not override it or overwrite its message.
  //   - the canonical `blocked:` text tells the model the restriction is
  //     INTENTIONAL and not to work around it. A preflight error instead offers
  //     an alternative the owner may have forbidden too.
  //   - `preflight` receives the full ToolContext and may run async code or
  //     touch the DB. A blocked tool should execute NONE of its own code, and a
  //     doc comment is not a guarantee that some future preflight stays pure.
  const blockingRule = matchApprovalRule(opts.approvalRules, tool.name, ctx.agentId, ctx.entityId);
  if (blockingRule?.action !== 'block' && tool.preflight) {
    // ── 1.5 Preflight — refuse BEFORE anyone is asked to approve ─────────────
    // Ordering is the whole point. Everything below writes an approval request
    // and hands a human a card describing what is about to happen; a call that
    // cannot honour that description must be stopped before the card exists,
    // not after it is approved. See ToolDefinition.preflight for the review
    // finding that put this here.
    try {
      await tool.preflight(validatedInput, ctx);
    } catch (err) {
      const result: ToolExecutionResult = {
        outcome: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
      await _writeToolCall(
        ctx,
        auditTool,
        validatedInput,
        JSON.stringify(result),
        Date.now() - startMs,
      );
      return result;
    }
  }

  // ── 2. Approval gate ───────────────────────────────────────────────────────
  const rawMatchedRule = matchApprovalRule(
    opts.approvalRules,
    tool.name,
    ctx.agentId,
    ctx.entityId,
  );
  // Un wildcard `*` auto_approve ne vaut PAS consentement à exécuter du code
  // (revue sécurité du 25/08). C'est le même trou que la relaxation d'autonomie,
  // par une autre porte : une règle « tout auto » attrapée en priorité 5/6
  // devenait un matchedRule, donc la garde ci-dessous — protégée par
  // `!matchedRule` — ne s'appliquait plus. Le blanc-seing est ignoré ici, et
  // l'outil retombe sur sa posture par défaut : approbation demandée, à moins
  // qu'une règle NOMMANT l'outil (le toggle Yolo de l'agent) ne l'autorise.
  //
  // Seul le sens permissif est neutralisé : un wildcard `require_approval` ou
  // `block` continue de s'appliquer — durcir vaut toujours.
  const matchedRule =
    rawMatchedRule?.toolName === '*' &&
    rawMatchedRule.action === 'auto_approve' &&
    isCodeExecutionTool(tool.name)
      ? undefined
      : rawMatchedRule;
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
  //
  // …avec une EXCEPTION sur `fully_autonomous` × outils d'exécution de code
  // (revue P0 du 25/08, finding bloquant).
  //
  // Avant l'inversion du modèle à deux clés (#24), le runner injectait un
  // require_approval sur ces outils à chaque job hors local-trust ; ce
  // `matchedRule` synthétique bloquait toute relaxation. En rendant
  // l'injection conditionnelle au frein (relâché par défaut), la #24 a
  // rouvert le chemin : `fully_autonomous` + zéro règle = shell auto-exécuté
  // sans qu'aucun toggle Yolo par agent n'ait été tourné. Un blanc-seing
  // « plus jamais de question » ne peut pas valoir consentement à exécuter du
  // code arbitraire : ce consentement-là s'exprime UNIQUEMENT par une règle
  // explicite (le toggle Yolo de l'agent), honorée juste au-dessus.
  //
  // `destructive_gate` n'est PAS concerné, et c'est délibéré : il ne signe pas
  // un blanc-seing, il JUGE chaque appel — une commande destructrice ou
  // lourde reste gatée, run_skill_script/skill_file_write/code_task le sont
  // par leur riskLevel. C'est la posture documentée « auto, mais garde les
  // destructions », et la retirer casserait un comportement voulu et testé.
  //   - destructive_gate → auto-approve ordinary work, but KEEP the gate for a
  //     `destructive` tool or a destructive/heavy run_command (rm, install, kill…).
  if (!matchedRule && effectiveAction === 'require_approval') {
    if (opts.autonomy === 'fully_autonomous' && !isCodeExecutionTool(tool.name)) {
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
      // MCP tools are judged like any other tool here — by their riskLevel.
      //
      // MCP-001's fix (2026-08-07, commit 5aba6b0) briefly added
      // `else if (tool.name.includes('__')) isHeavy = true`, which put EVERY
      // third-party tool in the heavy bucket. That silently redefined a setting
      // the owner had chosen: `destructive_gate` says "gate the destructive",
      // and it started gating `get_post` and a CHANGELOG fetch. Removed after
      // the owner reported it — an autonomy level that does not mean what it
      // says is worse than no autonomy level, because the next thing people do
      // is grant a blanket `*` rule.
      //
      // The MCP-001 finding is still closed, at the layer where it belongs:
      // every MCP tool ships `defaultApproval: 'require_approval'`, so a fresh
      // install — shipped default autonomy, or `propose_confirm` — still gates
      // foreign code on first use. What changes here is that an owner who
      // EXPLICITLY chose "autonomous, gate destructive" gets that.
      //
      // The residual risk is real and belongs to that choice: `riskLevel` for
      // an MCP tool comes from annotations the server supplies, so a hostile
      // server can declare itself non-destructive. `destructiveHint` can only
      // RAISE the level (riskFromAnnotations never honours `readOnlyHint` as a
      // downgrade), and the catastrophic-command and stdio floors below still
      // apply unconditionally.
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
    // Prescriptive, like the delegation refusals (delegation_depth_exceeded…):
    // the bare word "blocked" gave the model nothing to correct with — it
    // would retry the same tool or probe for workarounds (étape C, review
    // loop: a read-only reviewer needs to be TOLD the posture is intentional).
    const result: ToolExecutionResult = {
      outcome: 'error',
      error:
        `blocked: an approval rule forbids "${tool.name}" for this agent. This is an ` +
        `intentional restriction set by the owner — do NOT retry it and do NOT work around it ` +
        `via other tools or sub-agents. Use your allowed tools, or report the limitation in ` +
        `your result.`,
    };
    await _writeToolCall(
      ctx,
      auditTool,
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
        // étape D: the originating tool_use id — lets the resume path target
        // the EXACT awaiting marker instead of matching by toolName alone.
        toolCallId: ctx.toolCallId ?? null,
        status: 'pending',
      })
      .returning();

    if (!row) {
      // Fallthrough — fail loud
      const result: ToolExecutionResult = { outcome: 'error', error: 'approval_insert_failed' };
      await _writeToolCall(
        ctx,
        auditTool,
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
      auditTool,
      validatedInput,
      JSON.stringify(approvalResult),
      Date.now() - startMs,
    );
    return approvalResult;
  }

  // ── 2.9 Checkpoint — a net under anything that writes ──────────────────────
  //
  // Taken AFTER approval and BEFORE execution: the point is to capture the tree
  // the owner agreed to change, as it was at the instant before the change.
  // Once per turn, not per call — a turn with eight edits is one unit of work,
  // and eight snapshots of it would bury the useful one.
  //
  // A failure here REFUSES the write. That is deliberate and it is the whole
  // contract: a net that silently is not there is worse than no net, because it
  // is the one the owner believed they had (invariant #4).
  if (tool.mutatesWorkspace) {
    // ── 2.8 Intention de mutation — le projet est sale AVANT d'être écrit ────
    //
    // Même endroit, même raison que l'instantané ci-dessous : après
    // l'approbation (salir un projet pour un appel qui reste
    // `awaiting_approval` et sera peut-être refusé n'aurait aucun sens) et
    // avant `tool.execute`. UN seul point de pose pour les cinq outils
    // mutants, au lieu de cinq disciplines parallèles — « avant la mutation »
    // devient vrai par construction.
    const intentFailure = await takeMutationIntent(tool, validatedInput, ctx);
    if (intentFailure) {
      const result: ToolExecutionResult = { outcome: 'error', error: intentFailure };
      await _writeToolCall(
        ctx,
        auditTool,
        validatedInput,
        JSON.stringify(result),
        Date.now() - startMs,
      );
      return result;
    }

    const failure = await takeCheckpointForTurn(tool.name, ctx);
    if (failure) {
      const result: ToolExecutionResult = { outcome: 'error', error: failure };
      await _writeToolCall(
        ctx,
        auditTool,
        validatedInput,
        JSON.stringify(result),
        Date.now() - startMs,
      );
      return result;
    }
  }

  // ── 3. Execute ─────────────────────────────────────────────────────────────
  try {
    const output = await tool.execute(validatedInput, ctx);
    const durationMs = Date.now() - startMs;
    await _writeToolCall(ctx, auditTool, validatedInput, JSON.stringify(output), durationMs, {
      value: output,
    });
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
      auditTool,
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

/**
 * Turns already checkpointed, so eight edits in one turn cost one snapshot.
 *
 * Keyed by job + turn + workspace. Bounded by eviction rather than by a timer:
 * a Map that only grows is a leak in a process that runs for weeks.
 */
const checkpointedTurns = new Set<string>();
const MAX_REMEMBERED_TURNS = 500;

/**
 * Mark the projects this call is about to write as dirty, BEFORE it writes.
 *
 * Returns null when execution may proceed, or the error string that must
 * REFUSE the write — the same contract as the checkpoint below, for the same
 * reason: a guard that silently is not there is worse than no guard, because
 * it is the one the owner believed they had (invariant #4).
 *
 * The target comes from the tool, never from a guess here (see
 * `resolveMutationTargets` in types.ts). A mutating tool that declares no hook
 * falls back to EVERY attached workspace — conservative, which is the side to
 * err on: a project marked dirty for nothing costs a proof, a project missed
 * costs an unverified delivery.
 */
async function takeMutationIntent<TInput extends z.ZodTypeAny, TOutput>(
  tool: ToolDefinition<TInput, TOutput>,
  input: z.infer<TInput>,
  ctx: ToolContext,
): Promise<string | null> {
  // A mutating tool absent from the surface table cannot be attributed to any
  // owner setting — it would write outside verification without anyone having
  // chosen that. Refused, not silently allowed (T18 turns this into an
  // architecture test that enumerates the registry).
  const surface = surfaceForTool(tool.name);
  if (!surface) {
    console.error(
      `[verification] VERIFICATION_SURFACE_UNMAPPED tool=${tool.name} job=${ctx.jobId}`,
    );
    return 'verification_intent_failed: intent_surface_unmapped';
  }

  // Un outil mutant SANS hook est refusé, jamais rangé au hasard.
  //
  // Le repli d'avant fabriquait des cibles « tous les workspaces attachés, en
  // projet de code ». Conservateur en apparence, faux en pratique : il
  // réintroduisait ICI le littéral de classement que v7-A vient de retirer du
  // helper d'intention, et il aurait classé en code un outil qui produit tout
  // autre chose (revue Codex PR #46, passe 5). Le seul endroit qui SAIT ce
  // qu'un appel produit est l'outil ; sans sa déclaration, on ne devine pas.
  //
  // Ce cas est déjà interdit par le test d'architecture du registre (T18) :
  // ce refus est la garde qui le rend vrai à l'exécution aussi.
  if (!tool.resolveMutationTargets) {
    console.error(
      `[verification] VERIFICATION_INTENT_NO_TARGETS_HOOK tool=${tool.name} job=${ctx.jobId}`,
    );
    return 'verification_intent_failed: intent_no_targets_hook';
  }

  let targets: readonly MutationTarget[];
  try {
    targets = await tool.resolveMutationTargets(input, ctx);
  } catch (err) {
    console.error(
      `[verification] VERIFICATION_INTENT_TARGETS_FAILED tool=${tool.name} job=${ctx.jobId} ` +
        `error=${err instanceof Error ? err.message : String(err)}`,
    );
    return 'verification_intent_failed: intent_targets_failed';
  }

  const outcome = await writeMutationIntent(ctx, { surface, targets });
  if (outcome.kind === 'failed') return `verification_intent_failed: ${outcome.code}`;

  // ── Le REGISTRE des projets (P5), sur les MÊMES cibles ────────────────────
  //
  // Posé ici et pas ailleurs parce que c'est le seul endroit qui connaît à la
  // fois le job et ce que l'appel s'apprête à produire. Appelé quand
  // l'écriture VA avoir lieu (`written`, `no_targets`, `skipped`) et jamais
  // quand elle est refusée (`failed`, `already_terminal`) : un projet ne se
  // « rattache » pas un travail qui n'aura pas lieu.
  //
  // Son résultat n'influe PAS sur le retour : c'est un registre, pas une
  // garde. Une panne de rattachement ne doit pas refuser une écriture que
  // l'intention, elle, a autorisée — elle se dit dans les logs, par un code.
  if (outcome.kind !== 'already_terminal') {
    await attachProductionToProject(
      { db: ctx.db, entityId: ctx.entityId, jobId: ctx.jobId || null },
      targets,
    );
  }

  // Un job déjà terminal (annulé, échoué, terminé) ne doit plus RIEN écrire :
  // aucune finalisation ne repassera prouver ce qu'il changerait, et un
  // `cancelled` qui continue d'écrire n'est pas annulé. Refusé, pas laissé
  // passer sans intention (revue de T16).
  if (outcome.kind === 'already_terminal')
    return 'verification_intent_failed: intent_already_terminal';
  return null;
}

/**
 * Snapshot the workspace before a mutating tool runs.
 *
 * Returns null when the write may proceed (snapshot taken, already taken this
 * turn, or no store configured), or an error message when it must not.
 */
async function takeCheckpointForTurn(toolName: string, ctx: ToolContext): Promise<string | null> {
  const store = ctx.checkpointsRoot;
  const workspaces = ctx.workspaces ?? [];

  // No store configured (tests, chat turns) — no net, and no pretence of one.
  // Said once rather than silently: an owner who thinks checkpoints are on
  // deserves to learn otherwise from a log line, not from a lost file.
  if (!store || workspaces.length === 0) {
    if (store && workspaces.length === 0) {
      console.warn(`[checkpoints] ${toolName}: no workspace resolved — running without a net`);
    }
    return null;
  }

  // EVERY workspace, not just the first.
  //
  // This took `ctx.workspaces[0].path` at first, which is not where the write
  // necessarily lands: `file_write` resolves its target by label or absolute
  // path (file-ops/workspace.ts), so an agent holding [docs, code] writing to
  // `code/x.ts` got a snapshot of `docs` — and the write proceeded, and
  // restoring gave back nothing. The per-turn key carried that same wrong
  // workspace, so every later write of the turn counted as already covered.
  //
  // executeTool cannot know the target without re-implementing each tool's
  // path resolution, and a net that depends on guessing right is not a net.
  // Snapshotting all of them costs one commit per workspace per turn against a
  // store that is already content-addressed — cheap, and correct whichever one
  // the tool picks.
  for (const ws of workspaces) {
    const workspace = ws.path;

    // A workspace that is not reachable is skipped, not fatal.
    //
    // Snapshotting all of them fixed the wrong-target bug but created another:
    // an agent holding [shared, archive] could no longer write to `shared`
    // because `archive` sat on an unmounted drive. The write was refused even
    // though its real target was healthy and already covered.
    //
    // The rule that resolves both: a directory we cannot even stat cannot be
    // the target either — a write into it would fail on its own. So skipping it
    // gives up no guarantee, while a snapshot that fails on a REACHABLE
    // workspace still refuses, because there we genuinely cannot tell whether
    // it is the one about to change.
    try {
      const st = await stat(workspace);
      if (!st.isDirectory()) throw new Error('not a directory');
    } catch {
      console.warn(
        `[checkpoints] ${toolName}: workspace "${workspace}" unreachable — skipped ` +
          `(a write there would fail anyway; other workspaces are still covered)`,
      );
      continue;
    }

    // `ctx.turn` is optional in the type. Without it, "once per turn" has no
    // meaning, so fall back to one snapshot per call — slower, never unsafe —
    // and say which mode is in effect rather than let the difference be invisible.
    const turnKey =
      ctx.turn === undefined
        ? `${ctx.jobId}:call:${Date.now()}:${workspace}`
        : `${ctx.jobId}:turn:${ctx.turn}:${workspace}`;

    if (checkpointedTurns.has(turnKey)) continue;

    try {
      const cp = await snapshot(store, workspace, `before ${toolName} (job ${ctx.jobId})`);
      if (checkpointedTurns.size >= MAX_REMEMBERED_TURNS) {
        const oldest = checkpointedTurns.values().next().value;
        if (oldest !== undefined) checkpointedTurns.delete(oldest);
      }
      checkpointedTurns.add(turnKey);
      if (cp) console.info(`[checkpoints] ${cp.sha.slice(0, 8)} ${workspace} before ${toolName}`);
    } catch (err) {
      // One workspace that cannot be snapshotted is enough to refuse: we have
      // no way to tell it is not the one about to be written.
      return (
        `checkpoint_failed: could not snapshot "${workspace}" before running "${toolName}", ` +
        `so the write was refused rather than run without a way back. ` +
        `Cause: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`
      );
    }
  }
  return null;
}

async function _writeToolCall(
  ctx: ToolContext,
  tool: ToolDefinition<z.ZodTypeAny, unknown>,
  input: unknown,
  output: string,
  durationMs: number,
  /** The tool's ACTUAL output — only on a successful execution; absent, the row records no payload. */
  produced?: { value: unknown },
): Promise<void> {
  const toolName = tool.name;
  // P1 (plan « De la maquette au produit »): the row carries the card the tool
  // DECLARES — as declared, never recomputed nor rabattue — and the payload its
  // present() drew from the output, so the conversation screen reads the row
  // and never the registry. A presenter that violates its card's contract is a
  // bug in THAT tool: never allowed to fail the agent's work, but never
  // invisible either (revue passe 14) — the row records the error in
  // `presentation_error`, keeps its card, and `presented` stays NULL, so the
  // screen shows raw input/output saying why, and the bug can be counted.
  const card: string = typeof tool.card === 'string' ? tool.card : 'generic';
  let presented: ToolCardPayload | null = null;
  let presentationError: string | null = null;
  if (produced) {
    try {
      presented = presentToolResult(tool, input, produced.value);
    } catch (err) {
      presentationError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.error(
        `[tools] presentation failed for "${toolName}" (job=${ctx.jobId}) — recorded on the row (presentation_error), presented=NULL:`,
        err,
      );
    }
  }
  try {
    await ctx.db.insert(toolCalls).values({
      entityId: ctx.entityId,
      jobId: ctx.jobId,
      toolName,
      card,
      presented,
      presentationError,
      // NOUVEAU-1: the audit trail is never re-executed, so we store a
      // secret-redacted copy — create_connector/create_mcp API keys and stdio
      // env values must not sit in cleartext in tool_calls or render to the
      // logs dashboard (LogsTable). The real value already reached the tool's
      // execute() above; only this copy is masked.
      toolInput: redactSecretsForAudit(input) as Record<string, unknown>,
      toolOutput: output,
      durationMs,
      // étape D: turn + tool_use id make this row joinable to the transcript
      // and to llm_calls — the full-copy output was previously unlinkable.
      turn: ctx.turn ?? null,
      toolCallId: ctx.toolCallId ?? null,
    });
  } catch (err) {
    // Audit write failure must never crash the tool execution path — but it
    // must never be INVISIBLE either (reproducibility audit 2026-08-19: the
    // silent catch made missing trace rows undiagnosable; no monitoring ever
    // existed despite the old comment claiming so).
    console.warn(
      `[tools] tool_calls audit insert failed (job=${ctx.jobId}, tool=${toolName}):`,
      err,
    );
  }
}

// Re-export error for downstream convenience
export { InvalidInputError };
