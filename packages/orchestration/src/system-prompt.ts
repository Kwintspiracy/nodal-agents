// system-prompt.ts — assemble the full system prompt for an agent
// Concatenates: personality (raw, untouched) + team block + skills metadata block
// Invariant 2: no hardcoded user-facing strings injected into the prompt.

import { eq } from '@nodalai/db';
import { agentSkillAssignments, agentSkills } from '@nodalai/db';
import { buildTeamBlock } from './team-block.js';
import type { Agent, AnyDrizzleDb } from './types.js';

// ─── buildSystemPrompt ────────────────────────────────────────────────────────

/**
 * Build the complete system prompt for an agent.
 *
 * Parts (in order):
 * 1. agent.personality — raw, untouched. The LLM speaks in its own voice.
 * 2. team block — `## Your team` section, data-driven from DB (empty for workers)
 * 3. skills metadata block — list of adapter names + tool counts (data-driven)
 *
 * The personality may contain `{{team}}` placeholder — if so, inject there.
 * Otherwise append the team block after the personality.
 *
 * @param agent  Agent row (must include id, personality, role, entityId)
 * @param db     Drizzle DB handle
 */
export async function buildSystemPrompt(agent: Agent, db: AnyDrizzleDb): Promise<string> {
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

  return personality + skillsMetadataBlock;
}
