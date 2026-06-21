// team-block.ts — auto-generate the ## Your team prompt section from DB
// Invariant 1: ZERO hardcoded agent slugs/names/metadata in this file.
// Every agent name, slug, skill, instruction comes from DB at runtime.

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
import type { AgentId, AnyDrizzleDb } from './types';
import { detectOrchestratorMode } from './orchestrator-mode';
import { summarizePurpose } from './router/assign-tools';

// ─── buildTeamBlock ───────────────────────────────────────────────────────────

/**
 * Build the `## Your team` section for an orchestrator's system prompt.
 *
 * The content is generated entirely from DB state:
 * - Children come from agent_assignments JOIN agents (active only)
 * - Skills come from agent_skill_assignments JOIN agent_skills
 * - Instructions come from agent_assignments.instructions
 *
 * Returns '' if the agent has no active children (worker mode — no team block needed).
 *
 * @param parentAgentId  The orchestrator agent's ID
 * @param db             Drizzle DB handle
 */
export async function buildTeamBlock(parentAgentId: AgentId, db: AnyDrizzleDb): Promise<string> {
  // Load children from DB
  const childRows = await db
    .select({
      subAgentId: agentAssignments.subAgentId,
      instructions: agentAssignments.instructions,
      agentName: agents.name,
      agentSlug: agents.slug,
      agentRole: agents.role,
      agentActive: agents.active,
      agentPersonality: agents.personality,
    })
    .from(agentAssignments)
    .innerJoin(agents, eq(agentAssignments.subAgentId, agents.id))
    .where(
      and(eq(agentAssignments.orchestratorId, parentAgentId as string), eq(agents.active, true)),
    );

  if (childRows.length === 0) return '';

  // Detect mode: router (has sub-orchestrators) or planner (workers only)
  const parentRow = await db
    .select({ role: agents.role, orchestratorMode: agents.orchestratorMode })
    .from(agents)
    .where(eq(agents.id, parentAgentId as string))
    .limit(1);

  const parent = parentRow[0];
  if (!parent) return '';

  const childrenForMode = childRows.map((r) => ({
    role: r.agentRole as 'agent' | 'orchestrator' | 'system',
  }));

  const mode = detectOrchestratorMode(
    {
      role: parent.role as 'agent' | 'orchestrator' | 'system',
      orchestratorMode: parent.orchestratorMode as 'router' | 'planner' | null,
    },
    childrenForMode,
  );

  // Load skill assignments for all children
  const childIds = childRows.map((r) => r.subAgentId);
  const skillRows = await Promise.all(
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
  for (const batch of skillRows) {
    for (const r of batch) {
      const existing = skillMap.get(r.agentId) ?? [];
      existing.push(r.skillName);
      skillMap.set(r.agentId, existing);
    }
  }

  // Load connector tool inventories for all children — the orchestrator needs
  // to know what each sub-agent CAN do (not just its skills) so it routes the
  // user's request to the right one. Pre-this-change Conciergus answered
  // "I don't have Airtable access" directly when asked to list bases instead
  // of delegating to Summarizus (who had Airtable assigned).
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

  // For each child: list of (slug, tool names enabled)
  const connectorMap = new Map<string, { slug: string; toolNames: string[] }[]>();
  for (const batch of connectorRows) {
    for (const r of batch) {
      const entry = ADAPTER_REGISTRY[r.slug];
      if (!entry) continue; // catalog entry without adapter — invisible to orchestrator too
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

  // Load MCP server inventories — same rationale as connectors. MCP servers
  // are a separate code path from connectors, so without this loop the
  // orchestrator has zero info about its children's MCP capabilities.
  // Empirically observed (2026-05-26): a router orchestrator refused 6× to
  // delegate a payments-API request to a child that had the matching MCP
  // server attached, because the MCP inventory was invisible here.
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

  // For each child: list of (server-slug, namespaced tool names enabled).
  // Tool names match the runtime convention `<sanitized-slug>__<original-name>`
  // (see packages/adapters/mcp/src/tools.ts) so the orchestrator sees the
  // exact tool identifier the child agent has at runtime.
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

  // Capability hint = the connector/MCP NAMES the child can use (not the full
  // per-operation list, which was noise the orchestrator couldn't route on). The
  // name conveys the capability so the orchestrator won't think the child lacks
  // an integration.
  function formatConnectorsTag(subAgentId: string): string {
    const conn = connectorMap.get(subAgentId);
    const mcp = mcpMap.get(subAgentId);
    const names: string[] = [];
    if (conn) names.push(...conn.map((c) => c.slug));
    if (mcp) names.push(...mcp.map((c) => c.slug));
    if (names.length === 0) return '';
    return `\n  Connectors: ${[...new Set(names)].join(', ')}`;
  }

  // Unified orchestrator: every orchestrator receives BOTH delegation toolsets at
  // runtime (assign_* for in-line/sequential delegation, create_task for parallel
  // fan-out — see apps/runner/src/job/execute.ts tool selection). So the prompt
  // presents BOTH styles and lets the model pick per request, rather than a hard
  // router/planner XOR. `mode` (auto-detected from child roles, or pinned by the
  // operator) is surfaced only as a soft default lean — never as an exclusive
  // instruction. The runtime enforces "one style per job": once create_task has
  // run, the assign_* path defers (execute.ts commit guard), so the two completion
  // models never collide on the same job.
  const defaultLean =
    mode === 'router'
      ? 'Default lean: this team includes sub-orchestrators, so in-line `assign_*` ' +
        'delegation is usually the right call — reach for `create_task` only when you ' +
        'have genuinely independent work to run in parallel.'
      : 'Default lean: this team is independent workers, so `create_task` parallel ' +
        'fan-out is usually the right call for multi-part work — use `assign_*` when a ' +
        'single agent can handle the whole request or when steps depend on each other.';

  // Build lines array (all data from DB — no hardcoded names)
  const lines: string[] = [];
  lines.push('## Your team\n');
  lines.push(
    'You orchestrate the agents below. You have TWO ways to delegate — choose the one ' +
      'that fits the request:\n',
  );
  lines.push(
    '- **`assign_<agent>` — one delegation, in-line.** Hand the request (or a single ' +
      'step of it) to ONE agent and get its result back before continuing. Use this for a ' +
      'single delegation, or when the next step depends on this one’s result (reactive / ' +
      'sequential work). Only one assignment per turn; after the agent returns, either ' +
      'finish with `return_result` or assign the next step. Do NOT delegate again unless ' +
      'the request needs another step.',
  );
  lines.push(
    '- **`create_task` — parallel fan-out.** Create several INDEPENDENT tasks at once, ' +
      'each `assigned_to` an agent by its handle. They run concurrently in the background ' +
      'and their results are compiled and delivered automatically once all finish. Use ' +
      'this when the pieces of work do not depend on each other and can run in parallel. ' +
      'Use `depends_on` to order tasks that must run in sequence within the board. After ' +
      'creating the tasks, end your turn with a brief `return_result` acknowledgment — the ' +
      'task board runs them, so do NOT call `list_tasks` to wait (only use it to fetch a ' +
      'task ID for a `depends_on` reference).\n',
  );
  lines.push(
    '⚠️ THE FINAL SUMMARY TO THE USER IS AUTOMATIC — NEVER MAKE IT A TASK. Once the work tasks ' +
      'finish, the system composes a short summary of the whole run and sends it to the user on ' +
      'their original channel by itself. So even when the user says "puis fais une synthèse et ' +
      'envoie-la moi" / "then summarize and send it to me", that final summarize-and-send step is ' +
      'ALREADY handled — do NOT turn it into a task and do NOT add a `depends_on` "synthèse"/' +
      '"summary"/"→ Telegram" task. Creating one produces a DUPLICATE and an extra useless run. ' +
      'Create ONLY the real work tasks, then `return_result`. If the user wants a long deliverable ' +
      '(a file, an Obsidian note, an email, an HTML page), make a work task that PRODUCES that ' +
      'artifact — but the chat reply itself is never a task.\n',
  );
  lines.push('Pick ONE style per request — do not mix them in the same job. ' + defaultLean + '\n');
  lines.push('Your agents:');
  for (const row of childRows) {
    const { subAgentId, agentName, agentSlug, agentRole, instructions, agentPersonality } = row;
    const toolSlug = agentSlug.replace(/-/g, '_');
    // What the agent is FOR (summary of its personality) — drives correct routing.
    const purpose = summarizePurpose(agentPersonality);
    const purposeTag = purpose ? `\n  Purpose: ${purpose}` : '';
    const skills = skillMap.get(subAgentId) ?? [];
    const skillsTag = skills.length > 0 ? `\n  Skills: ${skills.join(', ')}` : '';
    const connectorsTag = formatConnectorsTag(subAgentId);
    const roleTag = agentRole === 'orchestrator' ? ' (orchestrator)' : '';
    const instrTag = instructions ? `\n  Instructions: ${instructions}` : '';
    lines.push(
      `- **${agentName}**${roleTag} — assign tool \`assign_${toolSlug}\`, task handle ` +
        `\`${agentSlug}\`${purposeTag}${skillsTag}${connectorsTag}${instrTag}`,
    );
  }

  return lines.join('\n');
}
