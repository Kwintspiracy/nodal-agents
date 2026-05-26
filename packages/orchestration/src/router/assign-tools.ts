// router/assign-tools.ts — generate assign_* tools from DB
// Reads children from agent_assignments table. Never hardcodes agent slugs.

import { z } from 'zod';
import { eq, and } from '@nodal-agents/db';
import {
  agents,
  agentAssignments,
  agentSkillAssignments,
  agentSkills,
  agentConnectorAssignments,
  connectors as connectorsTable,
  agentMcpServers,
  mcpServers,
} from '@nodal-agents/db';
import { ADAPTER_REGISTRY } from '@nodal-agents/runner-adapters';
import { DelegationPendingError } from '../errors';
import type { AgentId, AnyDrizzleDb, ToolDefinition, ChildAgent } from '../types';

// ─── Input schema for every assign_* tool ────────────────────────────────────

const assignInputSchema = z.object({
  task: z.string().describe('What this agent should do. Be specific and complete.'),
  data: z
    .string()
    .optional()
    .describe(
      'Data from a previous step to pass to this agent (e.g. spreadsheet content, search results).',
    ),
});

export type AssignInput = z.infer<typeof assignInputSchema>;

// ─── generateAssignTools ──────────────────────────────────────────────────────

/**
 * Generate one `assign_<slug>` tool per child agent of `parentAgentId`.
 *
 * Children are read from `agent_assignments` + `agents` tables.
 * Tool names are always `assign_<slug>` where slug has hyphens replaced by
 * underscores (e.g. `email-bot` → `assign_email_bot`).
 *
 * Each tool's execute() creates the child job, then throws DelegationPendingError
 * to signal to the runner that the parent must suspend.
 *
 * The runner catches DelegationPendingError and calls handleDelegation() to:
 *   1. Suspend the parent job (awaiting_delegation)
 *   2. Store pending_delegation metadata
 *
 * @param parentAgentId  The orchestrator's agent ID
 * @param db             Drizzle DB handle
 * @returns              Array of ToolDefinition — one per active child
 */
export async function generateAssignTools(
  parentAgentId: AgentId,
  db: AnyDrizzleDb,
): Promise<ToolDefinition<typeof assignInputSchema, never>[]> {
  // Load children via agent_assignments JOIN agents
  const rows = await db
    .select({
      subAgentId: agentAssignments.subAgentId,
      instructions: agentAssignments.instructions,
      agentName: agents.name,
      agentSlug: agents.slug,
      agentRole: agents.role,
      agentActive: agents.active,
    })
    .from(agentAssignments)
    .innerJoin(agents, eq(agentAssignments.subAgentId, agents.id))
    .where(
      and(eq(agentAssignments.orchestratorId, parentAgentId as string), eq(agents.active, true)),
    );

  if (rows.length === 0) return [];

  // Fetch skill names per agent for richer tool descriptions
  const childIds = rows.map((r) => r.subAgentId);
  const allSkillRows = await Promise.all(
    childIds.map((id) =>
      db
        .select({
          agentId: agentSkillAssignments.agentId,
          skillName: agentSkills.name,
          skillSlug: agentSkills.slug,
        })
        .from(agentSkillAssignments)
        .innerJoin(agentSkills, eq(agentSkillAssignments.skillId, agentSkills.id))
        .where(eq(agentSkillAssignments.agentId, id as string)),
    ),
  );

  const skillMap = new Map<string, string[]>();
  for (const skillBatch of allSkillRows) {
    for (const r of skillBatch) {
      const existing = skillMap.get(r.agentId) ?? [];
      existing.push(r.skillName);
      skillMap.set(r.agentId, existing);
    }
  }

  // Load connector tool inventories per child — symmetric with the
  // ## Your team block (see team-block.ts). Without this, the orchestrator's
  // `assign_<child>` tool description omits capabilities the child actually
  // has and the LLM refuses to delegate ("I don't have Airtable access").
  const connectorRows = await Promise.all(
    childIds.map((id) =>
      db
        .select({
          agentId: agentConnectorAssignments.agentId,
          slug: connectorsTable.slug,
          enabledOperations: agentConnectorAssignments.enabledOperations,
        })
        .from(agentConnectorAssignments)
        .innerJoin(connectorsTable, eq(connectorsTable.id, agentConnectorAssignments.connectorId))
        .where(eq(agentConnectorAssignments.agentId, id as string)),
    ),
  );

  const connectorMap = new Map<string, { slug: string; toolNames: string[] }[]>();
  for (const batch of connectorRows) {
    for (const r of batch) {
      const entry = ADAPTER_REGISTRY[r.slug];
      if (!entry) continue;
      const allToolNames = entry.operations.map((o) => o.slug);
      const toolNames =
        r.enabledOperations === null
          ? allToolNames
          : allToolNames.filter((n) => r.enabledOperations!.includes(n));
      if (toolNames.length === 0) continue;
      const existing = connectorMap.get(r.agentId) ?? [];
      existing.push({ slug: r.slug, toolNames });
      connectorMap.set(r.agentId, existing);
    }
  }

  // Load MCP server inventories per child — same rationale. A router
  // orchestrator refused 6× in a row to delegate work the child could
  // actually do (2026-05-26) because this tool description omitted the
  // child's MCP capabilities.
  const mcpRows = await Promise.all(
    childIds.map((id) =>
      db
        .select({
          agentId: agentMcpServers.agentId,
          serverSlug: mcpServers.slug,
          enabledTools: agentMcpServers.enabledTools,
          availableTools: mcpServers.availableTools,
          serverActive: mcpServers.active,
        })
        .from(agentMcpServers)
        .innerJoin(mcpServers, eq(mcpServers.id, agentMcpServers.mcpServerId))
        .where(eq(agentMcpServers.agentId, id as string)),
    ),
  );

  const mcpMap = new Map<string, { slug: string; toolNames: string[] }[]>();
  for (const batch of mcpRows) {
    for (const r of batch) {
      if (r.serverActive === false) continue;
      const prefix = r.serverSlug.replace(/-/g, '_');
      const available = Array.isArray(r.availableTools)
        ? (r.availableTools as Array<{ name?: unknown }>)
            .map((t) => (t && typeof t.name === 'string' ? t.name : null))
            .filter((n): n is string => n !== null)
        : [];
      if (available.length === 0) continue;
      const enabled = Array.isArray(r.enabledTools)
        ? new Set((r.enabledTools as unknown[]).filter((n): n is string => typeof n === 'string'))
        : null;
      const kept = enabled === null ? available : available.filter((n) => enabled.has(n));
      if (kept.length === 0) continue;
      const toolNames = kept.map((n) => `${prefix}__${n}`);
      const existing = mcpMap.get(r.agentId) ?? [];
      existing.push({ slug: r.serverSlug, toolNames });
      mcpMap.set(r.agentId, existing);
    }
  }

  function formatToolsTag(subAgentId: string): string {
    const conn = connectorMap.get(subAgentId);
    const mcp = mcpMap.get(subAgentId);
    const parts: string[] = [];
    if (conn) parts.push(...conn.map((c) => `${c.slug} (${c.toolNames.join(', ')})`));
    if (mcp) parts.push(...mcp.map((c) => `${c.slug} (${c.toolNames.join(', ')})`));
    if (parts.length === 0) return '';
    return ` Tools: ${parts.join('; ')}.`;
  }

  // Build one tool per child
  const tools: ToolDefinition<typeof assignInputSchema, never>[] = [];

  for (const row of rows) {
    const { subAgentId, instructions, agentName, agentSlug, agentRole } = row;

    // Normalize slug: hyphens → underscores for valid tool names
    const toolSlug = agentSlug.replace(/-/g, '_');
    const toolName = `assign_${toolSlug}`;

    // Build description from live DB data (never hardcoded)
    const skills = skillMap.get(subAgentId) ?? [];
    const skillsDesc = skills.length > 0 ? ` Skills: ${skills.join(', ')}.` : '';
    const toolsDesc = formatToolsTag(subAgentId);
    const roleNote = agentRole === 'orchestrator' ? ' (orchestrator — manages their own team)' : '';
    const instrNote = instructions ? ` Instructions: ${instructions}` : '';

    const description =
      `Assign a task to ${agentName}${roleNote}.${skillsDesc}${toolsDesc}${instrNote}`.trim();

    // Capture in closure
    const capturedSlug = agentSlug;

    const tool: ToolDefinition<typeof assignInputSchema, never> = {
      name: toolName,
      description,
      inputSchema: assignInputSchema,
      riskLevel: 'write',
      // execute() throws DelegationPendingError — the runner must intercept this
      // and call handleDelegation() to suspend the parent and create the child job.
      // The tool never actually returns a value; the signal IS the error.
      execute: async (input: AssignInput) => {
        // This execute is a sentinel — the runner intercepts DelegationPendingError
        // before it propagates. The child job ID will be set by handleDelegation().
        throw new DelegationPendingError(
          // placeholder — handleDelegation will override with the real child job ID
          `pending:${capturedSlug}`,
          capturedSlug,
        );

        // Unreachable — typed as `never` return
        return input as never;
      },
    };

    tools.push(tool);
  }

  return tools;
}

// ─── getChildAgents ───────────────────────────────────────────────────────────

/**
 * Load child agents for a parent orchestrator from the DB.
 * Used by buildTeamBlock and detectOrchestratorMode.
 */
export async function getChildAgents(
  parentAgentId: AgentId,
  db: AnyDrizzleDb,
): Promise<ChildAgent[]> {
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      slug: agents.slug,
      role: agents.role,
      active: agents.active,
    })
    .from(agentAssignments)
    .innerJoin(agents, eq(agentAssignments.subAgentId, agents.id))
    .where(
      and(eq(agentAssignments.orchestratorId, parentAgentId as string), eq(agents.active, true)),
    );

  return rows.map((r) => ({
    id: r.id as AgentId,
    name: r.name,
    slug: r.slug,
    role: r.role as 'agent' | 'orchestrator' | 'system',
    description: r.name, // will be enriched by team-block.ts
  }));
}
