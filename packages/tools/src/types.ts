// @nodal-agents/tools — core types
// RiskLevel is imported from @nodal-agents/shared (single source of truth)

import type { z } from 'zod';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { EmbeddingClient } from '@nodal-agents/llm';
import type {
  MutationTarget,
  OperationRiskLevel,
  ToolCard,
  ToolCardPayload,
} from '@nodal-agents/shared';
import type { ChannelKind } from '@nodal-agents/delivery';

// RiskLevel is OperationRiskLevel — single source of truth from @nodal-agents/shared
export type RiskLevel = OperationRiskLevel;

// Re-exported so a tool file declaring `resolveMutationTargets` or `card`
// imports its argument type from the same place as the field itself.
export type { MutationTarget, ToolCard, ToolCardPayload };

// ─── ToolContext ───────────────────────────────────────────────────────────────

/**
 * Runtime context passed to every tool.execute() call.
 * Carries job/agent identity and the DB handle — enough for any built-in tool.
 * Adapter tools may extend this via their own sub-context if needed.
 */
export interface ToolContext {
  jobId: string;
  agentId: string;
  entityId: string;
  db: AnyDrizzleDb;
  /**
   * Job-loop turn this call belongs to (étape D — written into tool_calls.turn
   * so the full-copy audit rows join back to the transcript and to llm_calls).
   * Set by the runner on every ToolContext it builds inside the turn loop;
   * absent in lightweight test contexts (column stays NULL).
   */
  turn?: number;
  /**
   * The AI SDK tool-call id (`tool_use` block id) of THIS call (étape D).
   * Varies per call within a turn, so the runner spreads it per call:
   * `{ ...sharedToolCtx, toolCallId: call.id }`. Written into tool_calls and
   * approval_requests.
   */
  toolCallId?: string;
  /**
   * The conversationId that originated this job (set by the Telegram inbound
   * handler today — the name predates multichannel and stays `jobChatId` for
   * now; renaming it is cleanup-phase work, not S3).
   * null for jobs started from the dashboard, cron, or API.
   * Used by the delivery tools as the default reply target when the caller
   * does not explicitly provide a chatId argument.
   */
  jobChatId: string | null;
  /**
   * La CONVERSATION dont ce travail est un tour (P6, `conversations.id`).
   * Distinct de `jobChatId`, qui est l'identifiant du fil SUR le canal : une
   * même conversation Telegram change d'id ici dès que l'utilisateur tape
   * `/new`, sans que le chat change.
   *
   * Ce que le registre des projets en fait : poser le projet courant du fil
   * (attach.ts). `null`/absent hors conversation — cron, webhook, contextes de
   * test légers.
   */
  conversationId?: string | null;
  /**
   * The job's `agent_jobs.channel` value (S3 of the multichannel plan) —
   * 'telegram', 'cron', 'dashboard', 'api', … Populated by the runner from
   * `job.channel` at every ToolContext construction site. Used by
   * delivery-guard's resolveChannelForJob to pick which ChannelAdapter a
   * delivery tool sends through: when this IS a registered transport channel
   * it wins; otherwise the tool falls back to the agent's Telegram binding
   * (today's only transport) — see resolveTransportChannel. Absent in
   * lightweight test contexts, which get the same 'telegram' default.
   */
  jobChannel?: string;
  /**
   * Every transport channel this agent has a live credential for (S3
   * extension: no-transport-origin default), telegram-first then
   * CHANNEL_PRIORITY order — see `listActiveChannelsForAgent`
   * (@nodal-agents/delivery). Populated by the runner from the SAME checks
   * that gate which comm tools this job's whitelist gets (a Telegram bot
   * token, an enabled discord/slack/whatsapp `channel_bindings` row). Used by
   * delivery-guard's resolveChannelForJob so a job whose `jobChannel` isn't
   * itself a transport (cron, webhook, dashboard, api, …) defaults to the
   * agent's OWN active channel instead of unconditionally 'telegram' — an
   * agent bound only to Discord no longer fails with `telegram_no_bot_token`
   * just because its job was triggered by cron. Absent or empty ⇒
   * resolveTransportChannel falls back to its historical 'telegram' default.
   */
  activeChannels?: readonly ChannelKind[];
  /**
   * Explicit notify-channel override (B1, notify-channel-choice plan): set by
   * the runner from a fired cron job's `triggerContext.notifyChannel` when the
   * schedule EXPLICITLY chose a delivery channel (agent_schedules.notify_channel
   * non-null). When present, it wins over the `resolveTransportChannel(jobChannel,
   * activeChannels)` default that delivery-guard's resolveChannelForJob would
   * otherwise compute — the schedule's choice is what the job's chatId was
   * ALSO resolved against (run-schedules.ts), so both must agree. It does NOT
   * override an EXPLICIT `channel` argument a send tool call itself provides —
   * that caller-specified target still wins; this only changes the DEFAULT.
   * Absent for every job that isn't a cron fire with an explicit notify
   * channel — behavior is unchanged (falls through to the historical default).
   */
  notifyChannelOverride?: ChannelKind;
  /**
   * Embedding client for tools that persist or search semantic memory
   * (save_memory generates an embedding at write time). Optional: the runner
   * always provides it, but lightweight test contexts may omit it — memory
   * writes then simply store no embedding and search falls back to keyword.
   */
  embeddingClient?: EmbeddingClient;
  /**
   * List of workspaces for this agent, loaded from agent_workspaces rows at
   * job start by the runner (ordered by position ASC). Each entry carries a
   * `label` (the path prefix the LLM uses, e.g. "notes") and the absolute
   * `path` on the filesystem. An empty array means the agent has no workspace
   * configured — every file_* tool call fails loud with `workspace_not_configured`.
   *
   * Addressing:
   *   - Single workspace: label is optional — `file.md` resolves under the sole root.
   *   - Multiple workspaces: `<label>/<relative>` is required (e.g. "notes/file.md").
   */
  workspaces?: Array<{ label: string; path: string }>;
  /**
   * Absolute path to the community-skill store root (e.g. `~/.nodalai/skills`),
   * injected by the runner. Each installed skill's bundled files live under
   * `<skillStoreDir>/<slug>/`. Absent in lightweight contexts → the
   * `skill_file_*` tools fail loud (`skill_store_unavailable`) instead of
   * reading from an unknown location.
   */
  skillStoreDir?: string;
  /**
   * Absolute path to the shadow checkpoint store (e.g. `~/.nodalai/checkpoints`),
   * injected by the runner — same pattern as `skillStoreDir`, and for the same
   * reason: `packages/tools` must not decide where the user's data lives.
   *
   * Absent ⇒ no checkpoint is taken. That is the correct behaviour for
   * lightweight contexts (tests, chat turns) and it is stated rather than
   * silent: `executeTool` says so once per call when a mutating tool runs
   * unprotected.
   */
  checkpointsRoot?: string;
  /**
   * Slugs of the skills assigned to this agent. The `skill_file_*` tools only
   * allow reading the bundle of a skill the agent actually holds — an agent
   * cannot read another skill's files. Loaded by the runner from
   * agent_skill_assignments alongside requiredBuiltins.
   */
  assignedSkillSlugs?: string[];
  /**
   * Slugs of skills this agent is AUTHORIZED to execute bundled scripts for via
   * `run_skill_script` (agent_skill_assignments.scripts_authorized = true). A
   * subset of assignedSkillSlugs — the owner opts in per agent × skill. Absent
   * or empty ⇒ the agent runs no skill scripts (`run_skill_script` fails loud
   * with `scripts_not_authorized`). Loaded by the runner alongside assignedSkillSlugs.
   */
  scriptAuthorizedSkillSlugs?: string[];
  /**
   * Slugs of skills this agent is AUTHORIZED to WRITE files into via
   * `skill_file_write` (agent_skill_assignments.files_writable = true). A subset
   * of assignedSkillSlugs — the owner opts in per agent × skill. Absent or empty
   * ⇒ the agent writes no skill files (`skill_file_write` fails loud with
   * `files_not_writable`). Loaded by the runner alongside assignedSkillSlugs.
   */
  fileWritableSkillSlugs?: string[];
  /**
   * Infrastructure-provisioning capabilities for ROOT meta-tools that create
   * MCP servers (and, later, connectors). Injected by the runner, which owns
   * the MCP adapter and secret encryption — so packages/tools takes no
   * dependency on either. Absent in lightweight contexts: a meta-tool that
   * needs it fails loud (`provisioning_unavailable`) rather than writing an
   * unverified row.
   */
  provisioning?: ToolProvisioning;
  /**
   * Premium web-search backend INJECTED by the runner when the agent has a
   * Tavily or Firecrawl connector configured (priority: Tavily > Firecrawl).
   * The `web_search` builtin uses it in preference to its own free DuckDuckGo
   * fallback. Injected here — not resolved in packages/tools — because building
   * it requires the adapters + decrypted connector keys, which packages/tools
   * must never depend on (architecture rule: only the runner touches those).
   * Absent ⇒ `web_search` falls back to a keyless DuckDuckGo scrape.
   */
  searchBackend?: (
    query: string,
  ) => Promise<{ results: Array<{ title: string; url: string; snippet: string }> }>;
  /**
   * Resolve the REAL tool-name whitelist of an arbitrary agent in this
   * workspace (not necessarily the caller). Injected by the runner
   * (apps/runner/src/job/resolve-agent-tools.ts's resolveAgentToolNames) so
   * packages/tools can run the routine/schedule lint (H1b) without importing
   * the runner's job-assembly internals. Read-only, no MCP connections.
   * Absent in lightweight test contexts ⇒ a meta-tool that wants it (e.g.
   * create_schedule) simply skips the lint rather than failing loud — the
   * lint is advisory (warn, never block), so a missing capability here must
   * never break schedule creation.
   */
  resolveAgentToolNames?: (agentId: string) => Promise<Set<string>>;
}

// ─── ToolProvisioning ──────────────────────────────────────────────────────────

/**
 * MCP connect options for provisioning verification. Mirrors the MCP adapter's
 * option shape, redeclared here so packages/tools stays free of an adapter
 * dependency — the runner adapts `connectMcp` to this interface.
 */
export type ProvisionMcpConnect =
  | {
      transport: 'http';
      url: string;
      apiKey?: string;
      authScheme?: 'header' | 'query' | 'bearer';
      authParamName?: string;
    }
  | { transport: 'stdio'; command: string; args: string[]; env: Record<string, string> };

/**
 * A discovered MCP tool, redeclared here (mirrors the MCP adapter's
 * `McpToolDescriptor`) so packages/tools stays free of an adapter dependency.
 * `inputSchema` is what makes a cache "v2" per `isUsableMcpToolCache` in the
 * runner — omitting it forces every job to re-connect eagerly to rebuild the
 * toolset, so create_mcp MUST persist the full descriptor, not just
 * name/description.
 */
export interface ProvisionedMcpTool {
  name: string;
  description: string | null;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

/**
 * Capabilities the runner injects so ROOT meta-tools can verify-then-write
 * external infrastructure without packages/tools importing the MCP adapter or
 * the secrets package.
 */
export interface ToolProvisioning {
  /**
   * Connect to an MCP server and list its tools. MUST throw on any
   * connect/auth/spawn failure (fail-loud, no DB write); the caller MUST close
   * the returned connection.
   */
  connectMcp(opts: ProvisionMcpConnect): Promise<{
    tools: ProvisionedMcpTool[];
    close: () => Promise<void>;
  }>;
  /** Encrypt a secret value for at-rest storage. */
  encrypt(plaintext: string): string;
}

// ─── ToolDefinition ────────────────────────────────────────────────────────────

/**
 * A typed, self-describing tool that can be registered and executed.
 *
 * TInput  — Zod schema for the tool's input (validated before execute() is called)
 * TOutput — the resolved return type of execute()
 */
export interface ToolDefinition<TInput extends z.ZodTypeAny, TOutput> {
  name: string;
  description: string;
  inputSchema: TInput;
  riskLevel: OperationRiskLevel;
  /**
   * How this tool's RESULT is shown — the card the conversation view dispatches
   * on (plan « De la maquette au produit », P1). Declared by the tool, never
   * inferred from its name: the screen must not grow a `switch` over tool
   * names that has to be edited every time a tool is added. Same principle as
   * `resolveMutationTargets` for writes, and the same model as DeepSeek
   * Harness's `presentResult` — the tool speaks a neutral vocabulary
   * (`ToolCard`), the UI translates it.
   *
   * Optional in the TYPE so third-party tools (MCP servers, connector
   * adapters) compile without it; `cardForTool()` then resolves them to
   * `generic`, an HONEST card (raw input and output, said as such), not a
   * guess. Every tool the product ships MUST declare one — enforced by the
   * registry test (`cards.test.ts`), which names any builtin that falls back.
   */
  card?: ToolCard;
  /**
   * How THIS tool's output fills its card's payload (shapes in
   * `@nodal-agents/shared`, `tool-cards.ts`; builders in `presenters.ts`).
   * Required for every structured card (`read`, `search`, `files`, `table`,
   * `terminal`, `sent`, `checks`, `delegation`) — `assertToolCard` refuses the
   * tool otherwise, at registration. A `text` card needs none (the output is
   * shown as text); `generic` carries nothing.
   *
   * Called ONCE per successful execution, in `executeTool`, and the payload is
   * persisted on the `tool_calls` row (`presented`) — the screen never re-runs
   * a presenter, it reads what was recorded (same model as DeepSeek Harness's
   * result `meta`). For a failed output (`{ ok: false, reason }`) return
   * `failureText(reason)`: the row keeps the declared card, the payload says
   * why there is nothing to draw.
   */
  // Declared as a METHOD, not a function-typed property: method parameters
  // stay bivariant under strictFunctionTypes, so a tool typed on its own
  // input/output still assigns to the erased ToolDefinition<ZodTypeAny, unknown>
  // the registry and the audit path hold (same reason `execute` is a method).
  present?(args: { input: z.infer<TInput>; output: TOutput }): ToolCardPayload;
  /**
   * Approval posture when NO approval rule matches this tool. Absent (the norm)
   * means "execute" — the historical default. A tool sets this to
   * 'require_approval' to be SAFE-BY-DEFAULT: it suspends for human approval
   * unless an explicit `auto_approve` rule (e.g. a per-agent "Yolo" toggle)
   * overrides it. Used by `run_command`, which is far too dangerous to inherit
   * the global no-rule→execute default. This is per-tool opt-in, NOT a blanket
   * default-deny on every destructive tool (that broader posture is a separate,
   * deferred product decision).
   */
  defaultApproval?: 'require_approval';
  /**
   * Optional check that runs BEFORE the approval gate — the only hook that can
   * refuse a call without a human ever being asked about it.
   *
   * Throw to refuse. The message travels back as the tool's error, no approval
   * request is created, and `execute` is never reached.
   *
   * Why this exists (PR #6 review, 2026-08-21): `code_task` refuses codex on
   * platforms where its sandbox is not enforced, and justified that refusal by
   * "the choice is not offered rather than offered on false terms". It WAS
   * offered: the guard sat in `execute()`, which `executeTool` only reaches
   * AFTER writing an approval request and getting a human's approval. The card
   * stated a promise the run could not keep, the human approved it, and only
   * then did the refusal appear.
   *
   * `computeApproval` cannot serve this purpose — it is skipped whenever an
   * approval rule matches, whenever the posture is already 'require_approval'
   * (which is exactly the safe-by-default tools that need this most), and under
   * fully_autonomous. A refusal must not depend on any of those.
   *
   * Reserve it for "this call is impossible here, whoever approves it" —
   * platform, configuration, missing prerequisite. Not for per-call risk, which
   * is `computeApproval`'s job.
   */
  preflight?: (input: z.infer<TInput>, ctx: ToolContext) => Promise<void> | void;
  /**
   * This tool can change files in the agent's workspace.
   *
   * Drives the checkpoint taken before execution (see `checkpoints.ts`). It is
   * an EXPLICIT flag rather than something inferred, because every available
   * proxy is wrong in both directions:
   *
   *   - `riskLevel: 'destructive'` is a blanket safe-by-default posture, not a
   *     statement about the filesystem.
   *   - approval config is worse than useless here: `file_write` and
   *     `file_edit` declare no `defaultApproval` at all (they gate dynamically,
   *     only on a shared-workspace overwrite), while `attach_connector` does
   *     require approval and touches no file. Inferring from it would checkpoint
   *     connector edits and skip the actual writes — exactly backwards.
   *
   * Set it on tools that write INTO AN ATTACHED WORKSPACE, and only those.
   * Not « tools that write to disk » — this comment said that until the 05/09
   * and it was wrong in a way that mattered (revue Codex PR #46, passe 6):
   * `skill_file_write` writes to disk, inside the skill folder, which is no
   * workspace and no deliverable. It is correctly unflagged, and a reader
   * following the old wording would have flagged it. An over-broad flag also
   * makes every turn pay a snapshot it does not need.
   *
   * WHAT THIS DOES NOT GUARANTEE, said plainly: a tool that writes into a
   * workspace and FORGETS this flag skips the checkpoint and the verification
   * seam entirely. No type and no scanner catches that — proving a function
   * writes requires running it, and every static proxy (an `fs` import, a path
   * resolver shared with the read tools) is wrong in both directions. It is a
   * DECLARATION, like `riskLevel`. The registry's architecture test covers the
   * next step only: every tool that declares this must declare what it writes.
   */
  mutatesWorkspace?: boolean;
  /**
   * PER-CALL declaration of WHAT this call is about to write — the targets
   * from which the verification layer derives the deliverables it marks dirty
   * BEFORE the write happens (plan « Vérifier & Corriger », D8).
   *
   * OPTIONAL IN THE TYPE, REQUIRED IN FACT when `mutatesWorkspace` is true.
   * The seam REFUSES a mutating tool that declares no hook
   * (`intent_no_targets_hook`, execute.ts) and the registry's architecture
   * test (T18) fails on one. Expressing the pairing as a discriminated union
   * was tried and abandoned (revue Codex PR #46, passe 5): intersecting the
   * union with this interface loses the parameter bivariance every
   * `ToolDefinition<SpecificSchema>` relies on to be stored in a registry of
   * `ToolDefinition<z.ZodTypeAny>`, and produced 204 errors on unrelated
   * fields. The pairing is enforced, just not by the compiler — same
   * mechanism as invariants #1, #2 and #6 (see CLAUDE.md).
   *
   * Same argument as `computeApproval` right below: the answer depends on the
   * call's actual TARGET, not on the tool's identity. `file_write` writes one
   * resolved path; `run_command` hands a shell to the agent and that shell
   * writes wherever it likes. One flag cannot say both.
   *
   * The target must be DECLARED by the tool, never guessed at the seam. The
   * checkpoint layer already learned this the hard way (see
   * `takeCheckpointForTurn`: "executeTool cannot know the target without
   * re-implementing each tool's path resolution, and a net that depends on
   * guessing right is not a net"). A tool that declares nothing therefore
   * falls back CONSERVATIVELY to every workspace in `ctx.workspaces` — the
   * fallback the plan itself prescribes for the shell surfaces.
   *
   * Do NOT try to select tools by `riskLevel` instead: `file_write` and
   * `file_edit` are 'write', `run_command` is 'destructive', and the level is
   * a posture about human review, not a statement about the filesystem.
   *
   * Returning an EMPTY list is meaningful and different from declaring
   * nothing: it says "this call writes nothing" (e.g. `code_task` in read
   * mode) and no project is marked dirty.
   */
  resolveMutationTargets?: (
    input: z.infer<TInput>,
    ctx: ToolContext,
  ) => Promise<readonly MutationTarget[]>;
  /**
   * Optional PER-CALL destructiveness check, complementing the static
   * `defaultApproval` above for tools where gating depends on the call's
   * actual TARGET, not the tool's identity — e.g. `file_write`/`file_edit`
   * only need a human in the loop when the resolved path would overwrite an
   * EXISTING file inside the entity-wide SHARED workspace (D1), never for a
   * brand-new file or a workspace the owner explicitly attached. Declaring a
   * static `defaultApproval: 'require_approval'` on those tools would gate
   * EVERY write instead of just the destructive-on-shared ones, so this hook
   * exists to make that decision per call instead.
   *
   * Evaluated by `executeTool` only when no explicit approval rule matched
   * (same precedence as `defaultApproval` — an explicit rule always wins)
   * and autonomy is not `fully_autonomous`. Return 'require_approval' to gate
   * THIS call; return undefined to leave the tool's ordinary posture
   * untouched.
   */
  computeApproval?: (
    input: z.infer<TInput>,
    ctx: ToolContext,
  ) => Promise<'require_approval' | undefined>;
  execute: (input: z.infer<TInput>, ctx: ToolContext) => Promise<TOutput>;
}

// ─── ToolRegistry ─────────────────────────────────────────────────────────────

export interface ToolListFilter {
  riskLevels?: OperationRiskLevel[];
  names?: string[];
}

export interface ToolRegistry {
  register<TInput extends z.ZodTypeAny, TOutput>(tool: ToolDefinition<TInput, TOutput>): void;

  get(name: string): ToolDefinition<z.ZodTypeAny, unknown> | undefined;

  list(filter?: ToolListFilter): ToolDefinition<z.ZodTypeAny, unknown>[];

  /**
   * Convert registered tools to Vercel AI SDK tool format.
   * RiskLevel is dropped — the AI SDK format has no concept of risk.
   * names filter lets callers expose only a subset.
   */
  toAiSdkTools(filter?: { names?: string[] }): Record<string, AiSdkTool>;
}

// ─── Vercel AI SDK tool shape ─────────────────────────────────────────────────

/**
 * Minimal representation of a Vercel AI SDK tool entry.
 * The `ai` package's CoreTool has `description`, `parameters` (Zod schema), and
 * an optional `execute` function. We expose only the shape we produce here —
 * the runner assembles messages and calls the tool via executeTool(), not via
 * the SDK's built-in execution path.
 */
export interface AiSdkTool {
  description: string;
  inputSchema: z.ZodTypeAny;
}

// ─── ExecuteOptions ────────────────────────────────────────────────────────────

export interface ApprovalGateRequest {
  approvalRequestId: string;
  toolName: string;
  toolInput: unknown;
  jobId: string;
  agentId: string;
  entityId: string;
}

export interface ExecuteOptions {
  /** Approval rules loaded from DB for this agent/entity. Pass [] if not applicable. */
  approvalRules: ApprovalRule[];
  /**
   * The workspace ROOT's autonomy level, which relaxes the safe-by-default
   * `require_approval` posture — but ONLY where no explicit rule applies (a
   * user/master-switch `require_approval` rule still wins) and the
   * catastrophic-command hardline floor still forces a human decision:
   *   - `fully_autonomous`  → auto-approve everything (no prompts, the owner's call);
   *   - `destructive_gate`  → auto-approve ordinary work, but KEEP the gate for
   *     destructive/heavy actions (a `destructive` tool, or a run_command that
   *     deletes / installs / downloads / kills / formats — isDestructiveOrHeavyCommand);
   *   - `propose_confirm` / undefined → no relaxation (every gated tool still asks).
   */
  autonomy?: 'propose_confirm' | 'destructive_gate' | 'fully_autonomous';
  /**
   * Called when a tool requires approval. Caller (runner) is responsible for
   * updating job status and polling. Returns void — execution stops here.
   */
  onApprovalRequired: (req: ApprovalGateRequest) => Promise<void>;
}

// ─── Approval rule shape (mirrors shared ApprovalRule) ────────────────────────

export interface ApprovalRule {
  id: string;
  toolName: string;
  action: 'auto_approve' | 'require_approval' | 'block';
  agentId: string | null;
  entityId: string | null;
}

// ─── ToolExecutionResult ──────────────────────────────────────────────────────

export type ToolExecutionResult =
  | { outcome: 'success'; output: unknown }
  /**
   * `mayHaveDelivered` — set when a DELIVERY tool timed out after the request
   * was transmitted (DeliveryError.mayHaveDelivered): the message may well
   * have reached the user. The runner's delivery guard treats this as a
   * delivery (no re-send nudge) and the error text tells the LLM not to
   * resend — a blind retry is exactly what duplicates messages.
   */
  | { outcome: 'error'; error: string; mayHaveDelivered?: boolean }
  | { outcome: 'awaiting_approval'; approvalRequestId: string };

// ─── Constants ────────────────────────────────────────────────────────────────

/** Risk levels in severity order — used for comparisons and display. */
export const RISK_LEVELS: ReadonlyArray<RiskLevel> = ['read', 'write', 'destructive'] as const;
