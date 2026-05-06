// system-prompt.ts — assemble the full system prompt for an agent
// Concatenates: personality (raw, untouched) + team block + built-in capabilities
// + skills metadata block + (optional) delivery context block.
// Invariant 2: no hardcoded user-facing strings injected into the prompt.

import { eq } from '@nodalai/db';
import { agentSkillAssignments, agentSkills } from '@nodalai/db';
import { JOB_CHANNEL_DELIVERY_DOCS, type JobChannel } from '@nodalai/shared';
import { ALWAYS_ON_TOOL_DOCS } from '@nodalai/tools';
import { buildTeamBlock } from './team-block';
import type { Agent, AnyDrizzleDb } from './types';

// ─── DeliveryContext ──────────────────────────────────────────────────────────

/**
 * Per-job delivery information injected into the system prompt so the agent
 * knows where its `return_result` text will be delivered. Invariant: data, not
 * code — the description text is looked up in JOB_CHANNEL_DELIVERY_DOCS.
 */
export interface DeliveryContext {
  /** The job's `channel` field (any string — fallback applies if unknown). */
  channel: string;
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

// ─── buildDeliveryContextBlock ────────────────────────────────────────────────
// Tells the agent where its final `return_result` text will be delivered.
// Without this block, an agent asked "post X on Telegram" scans its tool list,
// finds no telegram-send tool, and concludes "I can't" — even though the
// runner's delivery layer auto-routes return_result based on job.channel.
// Data-driven from JOB_CHANNEL_DELIVERY_DOCS (single source of truth in
// @nodalai/shared, exhaustive Record<JobChannel, string>).
function buildDeliveryContextBlock(ctx: DeliveryContext): string {
  const description =
    JOB_CHANNEL_DELIVERY_DOCS[ctx.channel as JobChannel] ?? 'the channel configured for this job';
  return `## Delivery context\n\nWhen this job completes, your \`return_result\` text is delivered as ${description}. The platform handles transport — you do not need a separate "send" tool. Just write the text you want delivered.`;
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
 * 5. delivery context (optional) — per-job: where return_result is delivered
 *
 * The personality may contain `{{team}}` placeholder — if so, inject there.
 * Otherwise append the team block after the personality.
 *
 * @param agent             Agent row (must include id, personality, role, entityId)
 * @param db                Drizzle DB handle
 * @param deliveryContext   Optional per-job delivery info; when provided, adds
 *                          the "## Delivery context" block so the LLM knows
 *                          what its final reply text becomes.
 */
export async function buildSystemPrompt(
  agent: Agent,
  db: AnyDrizzleDb,
  deliveryContext?: DeliveryContext,
): Promise<string> {
  // 1. Start with the raw personality (never modify the agent's voice)
  let personality = agent.personality;

  // 2. Build team block (data-driven from DB — empty string for workers)
  const teamBlock = await buildTeamBlock(agent.id, db);

  // 3. Build skills metadata block (data-driven — list of skill names + slugs)
  const skillRows = await db
    .select({
      skillName: agentSkills.name,
      skillSlug: agentSkills.slug,
    })
    .from(agentSkillAssignments)
    .innerJoin(agentSkills, eq(agentSkillAssignments.skillId, agentSkills.id))
    .where(eq(agentSkillAssignments.agentId, agent.id as string));

  const skillsMetadataBlock =
    skillRows.length > 0
      ? `\n\n## Your available adapters\n\n${skillRows.map((r) => `- **${r.skillName}** (\`${r.skillSlug}\`)`).join('\n')}`
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

  // 6. Delivery context — per-job. Tells the LLM where its return_result text
  //    is going, so it stops speculating about transport ("I don't have a
  //    Telegram tool"). Data-driven, no hardcoded channel strings here.
  const deliveryBlock = deliveryContext ? '\n\n' + buildDeliveryContextBlock(deliveryContext) : '';

  return personality + '\n\n' + builtinBlock + skillsMetadataBlock + deliveryBlock;
}
