// system-prompt.ts — assemble the full system prompt for an agent
// Concatenates: personality (raw, untouched) + team block + built-in capabilities
// + skills block (full content, not just metadata) + job context (when provided
// by the runner). Invariant 2: no hardcoded user-facing strings injected.
//
// Skills inject their `content` field directly — this is how a user-authored
// skill ("when telegram_chat_id is in Job context, reply via
// telegram_send_message + return_result in the same turn, format like X")
// reaches the agent. Pre-Brique 32 only the skill name was injected, so the
// skill content was silently dropped. End-to-end skill behavior never worked.

import { eq } from '@nodal-agents/db';
import { agentSkillAssignments, agentSkills, agentWorkspaces } from '@nodal-agents/db';
import { selectMemoriesForInjection } from '@nodal-agents/memory';
import type { AgentMemory } from '@nodal-agents/shared';
import { ALWAYS_ON_TOOL_DOCS } from '@nodal-agents/tools';
import { buildTeamBlock } from './team-block';
import type { Agent, AnyDrizzleDb } from './types';

// ─── JobContext ────────────────────────────────────────────────────────────────

/**
 * Runtime context for the current job. Provided by the runner and injected into
 * the system prompt as a structured `## Job context` block. The agent's
 * personality decides what to do with this data (e.g. "if telegram_chat_id is
 * present, reply via telegram_send_message"). Never hardcoded in the runner.
 */
export interface JobContext {
  /** Origin channel of the job: 'api', 'telegram', 'cron', etc. */
  origin: string;
  /** Telegram chat ID, set when the job originated from or targets a Telegram chat. */
  telegramChatId?: string;
  /**
   * The user asked to be notified when this job succeeds (per-schedule opt-in).
   * Instruction to the LLM — it writes the confirmation in its own voice; the
   * runner only enforces that a delivery happens (invariant 2 holds).
   */
  notifyOnSuccess?: boolean;
}

// ─── buildJobContextBlock ─────────────────────────────────────────────────────

function buildJobContextBlock(ctx: JobContext): string {
  const lines = [`- origin: ${ctx.origin}`];
  if (ctx.telegramChatId) lines.push(`- telegram_chat_id: ${ctx.telegramChatId}`);
  if (ctx.notifyOnSuccess) {
    lines.push(
      '- notify_on_success: true — when this job finishes, send the user a short ' +
        'confirmation (what you did + the outcome) via your delivery tool before ' +
        'calling return_result.',
    );
  }
  return `\n\n## Job context\n${lines.join('\n')}`;
}

// ─── buildPersistentMemoryBlock ───────────────────────────────────────────────

/**
 * Render the auto-injected memory block (Sprint 2 — auto-injection).
 *
 * Goal: surface durable facts to the LLM without the agent having to call
 * `query_memory` every turn — the agent often forgets, and even when it
 * remembers, that's one round-trip of latency and tokens. With injection,
 * relevant memories live in the system prompt for the whole job.
 *
 * The block deliberately tells the LLM not to re-query for facts it already
 * sees here — saves tokens and avoids the dashboard becoming a wall of
 * redundant query_memory calls.
 *
 * Char overhead per entry MUST match `RENDER_OVERHEAD_PER_ENTRY` in
 * `packages/memory/src/inject.ts` (currently 20). Keep them in sync.
 */
function buildPersistentMemoryBlock(memories: ReadonlyArray<AgentMemory>): string {
  if (memories.length === 0) return '';
  const lines = memories.map((m) => `- (${m.category}, ${m.importance}★) ${m.fact}`).join('\n');
  return (
    `\n\n## Persistent memory\n\n` +
    `Durable facts loaded from your long-term memory. Treat as authoritative ` +
    `for the entity. DO NOT call \`query_memory\` to look up facts already listed ` +
    `here — only call it for facts that look missing.\n\n` +
    `${lines}`
  );
}

// ─── buildBuiltinCapabilitiesBlock ────────────────────────────────────────────
// Renders the always-on built-in tools so EVERY agent sees them explicitly in
// its system prompt — not buried in the LLM SDK's tool definitions, which can
// be ignored when the personality is strongly worded ("just do math").
// Data-driven from ALWAYS_ON_TOOL_DOCS — invariant #1 (no hardcoded metadata).
function buildBuiltinCapabilitiesBlock(): string {
  const lines = ALWAYS_ON_TOOL_DOCS.map((t) => `- **${t.name}**: ${t.description}`).join('\n');
  return `## Built-in capabilities\n\nThese tools are always available to you. Use them proactively when they fit:\n\n${lines}`;
}

// ─── buildWorkspacesBlock ─────────────────────────────────────────────────────
// Injects the agent's workspace list into the system prompt so the LLM knows
// exactly which workspaces exist and how to address files in each.
// Data-driven from DB (agent_workspaces) — no hardcoded agent text (invariant 2).
function buildWorkspacesBlock(
  workspaceList: ReadonlyArray<{ label: string; path: string }>,
): string {
  if (workspaceList.length === 0) return '';

  if (workspaceList.length === 1) {
    const ws = workspaceList[0]!;
    return (
      `\n\n## Workspace\n\n` +
      `Your workspace label is **${ws.label}** (path: \`${ws.path}\`). ` +
      `When using file_read / file_write / file_edit / file_list / file_search, ` +
      `you may use bare relative paths (e.g. \`notes.md\`) or prefix with the label ` +
      `(e.g. \`${ws.label}/notes.md\`). Both resolve to the same root.`
    );
  }

  const lines = workspaceList.map((ws) => `- **${ws.label}**: \`${ws.path}\``).join('\n');
  const example = workspaceList[0]!;
  return (
    `\n\n## Workspaces\n\n` +
    `This agent has multiple workspaces. Always prefix paths with the workspace label:\n\n` +
    `${lines}\n\n` +
    `Example: \`${example.label}/notes.md\` to access \`notes.md\` in the **${example.label}** workspace. ` +
    `Use \`file_list\` with no path to see all workspace labels.`
  );
}

// ─── buildSystemPrompt ────────────────────────────────────────────────────────

/**
 * Build the complete system prompt for an agent.
 *
 * Parts (in order):
 * 1. agent.personality — raw, untouched. The LLM speaks in its own voice.
 * 2. team block — `## Your team` section, data-driven from DB (empty for workers)
 * 3. built-in capabilities — always-on tools (return_result, save_memory, etc.)
 * 4. skills metadata block — list of adapter names + tool counts (data-driven)
 * 5. job context block — `## Job context` section with runtime data (when provided)
 *
 * The personality may contain `{{team}}` placeholder — if so, inject there.
 * Otherwise append the team block after the personality.
 *
 * @param agent       Agent row (must include id, personality, role, entityId)
 * @param db          Drizzle DB handle
 * @param jobContext  Optional runtime context for the current job (origin, telegramChatId, etc.)
 */
export async function buildSystemPrompt(
  agent: Agent,
  db: AnyDrizzleDb,
  jobContext?: JobContext,
): Promise<string> {
  // 1. Start with the raw personality (never modify the agent's voice)
  let personality = agent.personality;

  // 2. Build team block (data-driven from DB — empty string for workers)
  const teamBlock = await buildTeamBlock(agent.id, db);

  // 3. Build skills block — full content of each assigned skill, injected into
  //    the system prompt so the agent ACTS on the skill's instructions, not just
  //    sees a metadata label. (Pre-Brique 32 only `name + slug` were selected,
  //    leaving the actual instructions silently dropped — skills were decorative.)
  const skillRows = await db
    .select({
      skillName: agentSkills.name,
      skillContent: agentSkills.content,
    })
    .from(agentSkillAssignments)
    .innerJoin(agentSkills, eq(agentSkillAssignments.skillId, agentSkills.id))
    .where(eq(agentSkillAssignments.agentId, agent.id as string));

  // 3.5. Workspace list — loaded from agent_workspaces (Volet 5). Data-driven
  //      from DB so the LLM knows which workspaces exist + how to prefix paths.
  //      Ordered by position so the first workspace listed is the primary one.
  const workspaceRows = await db
    .select({ label: agentWorkspaces.label, path: agentWorkspaces.path })
    .from(agentWorkspaces)
    .where(eq(agentWorkspaces.agentId, agent.id as string))
    .orderBy(agentWorkspaces.position, agentWorkspaces.label);

  const skillsBlock =
    skillRows.length > 0
      ? `\n\n## Skills\n\n${skillRows
          .map((r) => `### ${r.skillName}\n\n${r.skillContent}`)
          .join('\n\n')}`
      : '';

  // 4. Assemble: honour {{team}} placeholder or append
  if (teamBlock) {
    if (personality.includes('{{team}}')) {
      personality = personality.replace('{{team}}', teamBlock);
    } else {
      personality = personality + '\n\n' + teamBlock;
    }
  }

  // 5. Built-in capabilities block — injected for every agent so the LLM sees
  //    save_memory / query_memory / return_result as first-class capabilities,
  //    not just optional tools buried in the SDK's tool list.
  const builtinBlock = buildBuiltinCapabilitiesBlock();

  // 5.5 Workspace block — tells the LLM which workspaces exist and how to address
  //     files (label/relative syntax for multi-workspace agents).
  const workspacesBlock = buildWorkspacesBlock(workspaceRows);

  // 6. Persistent memory block — Sprint 2 auto-injection. Top-N durable facts
  //    for the entity, sorted by importance × recency, fit under the agent's
  //    memoryTokenBudget. Skipped when entityId is null (system agents) or
  //    when the budget yields zero rows. Frozen snapshot — the block is built
  //    once per job assembly; mid-job writes via save_memory land on disk but
  //    do NOT mutate the in-flight system prompt (prefix-cache preservation,
  //    Hermes pattern). Next job picks them up.
  const memoryRows =
    agent.entityId !== null
      ? await selectMemoriesForInjection(db, {
          entityId: agent.entityId as string,
          maxChars: agent.memoryTokenBudget,
        })
      : [];
  const memoryBlock = buildPersistentMemoryBlock(memoryRows);

  // 7. Job context block — runtime data provided by the runner per-job.
  //    Only appended when jobContext is provided. The agent's personality
  //    decides how to use this data (e.g. send via Telegram if chat_id is set).
  const jobContextBlock = jobContext ? buildJobContextBlock(jobContext) : '';

  return (
    personality +
    '\n\n' +
    builtinBlock +
    workspacesBlock +
    memoryBlock +
    skillsBlock +
    jobContextBlock
  );
}
