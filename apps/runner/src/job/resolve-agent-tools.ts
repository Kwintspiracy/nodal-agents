// job/resolve-agent-tools.ts — resolveAgentToolNames: the tool NAME surface
// an agent can actually call, as a standalone read-only helper.
//
// This factors out the SAME whitelist-assembly logic executeJob (execute.ts
// §6-7) uses to build a job's runtime toolset, reusing the exact production
// building blocks (createToolRegistry/registerBuiltins, generateAssignTools/
// generateTaskTools, enabledMetaTools/parseRootGrants, createLazyMcpTools/
// slugToPrefix, getChannelBinding, delivery-tool factories, connector/MCP
// assembly) — nothing here is reimplemented from scratch. It exists so a
// caller that only needs to know WHICH TOOL NAMES an agent has (e.g. a
// routine/schedule lint — H1b) doesn't have to run a full job.
//
// Root incident (H1b): a cron routine told an agent to "retrieve the
// previously stored version from your state", implying a tool
// (`cogni_cortex__get_state`) the agent didn't actually have — the agent
// improvised and derailed. This helper lets a lint check a routine's tool
// references against the agent's REAL whitelist at schedule-creation time.
//
// READ-ONLY, by design:
//   - no INSERT/UPDATE/DELETE against the DB;
//   - no MCP network connection — MCP tool names are built from the DB-cached
//     `mcp_servers.available_tools` (the same "v2 cache" createLazyMcpTools
//     uses in execute.ts's lazy path) and never connected. A server without a
//     usable cache contributes no tool names (see fidelity note below).
//
// FIDELITY CAVEATS vs execute.ts's real per-job assembly:
//   - Connector adapter tool NAMES are read off each adapter's static
//     `toolFactory` with a placeholder token (never a real/decrypted
//     credential) — toolFactory only builds ToolDefinition objects
//     synchronously, so this is safe and produces the real tool names
//     without touching secrets.
//   - MCP servers WITHOUT a usable v2 tool cache contribute NO tool names.
//     execute.ts would eager-connect (spawn/network) to discover them; this
//     helper never does. This UNDER-approximates a freshly-attached MCP
//     server's tools (safe direction for a lint — it will never claim a tool
//     exists that hasn't been discovered yet, only possibly under-warn about
//     one that has).
//   - The worker branch always includes the FULL `ALWAYS_ON_TOOLS` set.
//     execute.ts strips `dashboard_publish` only for a DELEGATED worker
//     (job.parentJobId set) — this helper has no specific job/delegation
//     context, and a schedule always creates a fresh top-level (non-delegated)
//     job, so the full set is the correct approximation for that caller.
//   - The `configuredTools` derived from skill assignments mirrors
//     execute.ts's OWN (pre-existing) behavior verbatim, including its use of
//     `agentSkillAssignments.skillId` (a UUID FK, not a tool name) as the
//     candidate list — those never match a registered tool name in practice
//     and are filtered out by the registry-membership check, exactly as they
//     are in execute.ts. Not "fixed" here to stay byte-faithful to the
//     production assembly this helper mirrors.

import { eq } from '@nodal-agents/db';
import {
  agents,
  entities,
  agentSkillAssignments,
  agentSkills,
  agentConnectorAssignments,
  connectors as connectorsTable,
  mcpServers as mcpServersTable,
  agentMcpServers as agentMcpServersTable,
  getChannelBinding,
} from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import {
  createToolRegistry,
  registerBuiltins,
  computeToolWhitelist,
  ALWAYS_ON_TOOLS,
  createTelegramSendMessageTool,
  createSendImageTool,
  createSendFileTool,
  createSendVideoTool,
  createSendAudioTool,
  createSendVoiceTool,
  createListConversationsTool,
} from '@nodal-agents/tools';
import { enabledMetaTools, parseRootGrants } from '@nodal-agents/shared';
import { ADAPTER_REGISTRY } from '@nodal-agents/runner-adapters';
import {
  createLazyMcpTools,
  slugToPrefix,
  type McpToolDescriptor,
} from '@nodal-agents/adapter-mcp';
import { generateAssignTools, generateTaskTools } from '@nodal-agents/orchestration';
import type { AgentId } from '@nodal-agents/orchestration';
import { isUsableMcpToolCache } from './mcp-tool-cache.ts';

/**
 * Resolve the set of tool NAMES an agent can actually call — a read-only
 * reconstruction of the whitelist executeJob would build for a fresh,
 * non-delegated job. See module doc above for fidelity caveats.
 *
 * Throws if the agent does not exist (fail loud — a caller asking about an
 * unknown agent has a bug, not an empty-tools agent).
 */
export async function resolveAgentToolNames(
  db: AnyDrizzleDb,
  agentId: string,
): Promise<Set<string>> {
  const registry = createToolRegistry();
  registerBuiltins(registry);

  const [agentRow] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agentRow) throw new Error(`resolveAgentToolNames: agent ${agentId} not found`);

  const isOrchestrator = agentRow.role === 'orchestrator';

  // ── Skill assignments (mirrors execute.ts §3.6) ──────────────────────────
  const assignedSkillRows = await db
    .select({
      skillId: agentSkillAssignments.skillId,
      requiredBuiltins: agentSkills.requiredBuiltins,
      scriptsAuthorized: agentSkillAssignments.scriptsAuthorized,
      filesWritable: agentSkillAssignments.filesWritable,
    })
    .from(agentSkillAssignments)
    .innerJoin(agentSkills, eq(agentSkills.id, agentSkillAssignments.skillId))
    .where(eq(agentSkillAssignments.agentId, agentRow.id));

  const scriptToolNames: string[] = assignedSkillRows.some((r) => r.scriptsAuthorized === true)
    ? ['run_skill_script']
    : [];
  const fileWriteToolNames: string[] = assignedSkillRows.some((r) => r.filesWritable === true)
    ? ['skill_file_write']
    : [];

  // ── Delivery tools (mirrors execute.ts:1112-1153) ───────────────────────
  const deliveryBotToken = agentRow.telegramBotToken;
  const discordBinding = await getChannelBinding(db, agentRow.id, 'discord');
  const hasDiscordBinding = discordBinding?.enabled === true;
  const slackBinding = await getChannelBinding(db, agentRow.id, 'slack');
  const hasSlackBinding = slackBinding?.enabled === true;
  const deliveryToolNames: string[] = [];
  if (deliveryBotToken || hasDiscordBinding || hasSlackBinding) {
    deliveryToolNames.push(
      createTelegramSendMessageTool().name,
      createSendImageTool().name,
      createSendFileTool().name,
      createSendVideoTool().name,
      createSendAudioTool().name,
      createSendVoiceTool().name,
      createListConversationsTool().name,
    );
  }

  // ── Root meta-tool gating (mirrors execute.ts:1160-1183) ────────────────
  const [entityRow] = await db
    .select({ rootAgentId: entities.rootAgentId, rootGrants: entities.rootGrants })
    .from(entities)
    .where(eq(entities.id, agentRow.entityId ?? ''))
    .limit(1);
  const isRootAgent = entityRow?.rootAgentId != null && entityRow.rootAgentId === agentRow.id;
  const metaToolNames: string[] = isRootAgent
    ? enabledMetaTools(parseRootGrants(entityRow?.rootGrants)).filter(
        (name) => registry.get(name) !== undefined,
      )
    : [];

  // ── Connector adapter tool names (mirrors execute.ts:1193-1277) ─────────
  // No credential decryption — a placeholder token drives the SAME static
  // toolFactory() execute.ts calls with a real one; only NAMES are needed.
  const connectorAssignments = await db
    .select({
      slug: connectorsTable.slug,
      enabledOperations: agentConnectorAssignments.enabledOperations,
    })
    .from(agentConnectorAssignments)
    .innerJoin(connectorsTable, eq(connectorsTable.id, agentConnectorAssignments.connectorId))
    .where(eq(agentConnectorAssignments.agentId, agentRow.id));

  const connectorToolNames: string[] = [];
  for (const ca of connectorAssignments) {
    const entry = ADAPTER_REGISTRY[ca.slug];
    if (!entry) continue; // no adapter for this catalog slug — skip silently (matches execute.ts)
    const allTools = entry.toolFactory('__resolve_agent_tool_names_placeholder__');
    const enabled = ca.enabledOperations;
    const filtered = enabled === null ? allTools : allTools.filter((t) => enabled.includes(t.name));
    connectorToolNames.push(...filtered.map((t) => t.name));
  }

  // ── MCP server tool names (mirrors execute.ts:1305-1450, lazy/cache-only) ─
  const mcpAssignments = await db
    .select({
      slug: mcpServersTable.slug,
      availableTools: mcpServersTable.availableTools,
      enabledTools: agentMcpServersTable.enabledTools,
    })
    .from(agentMcpServersTable)
    .innerJoin(mcpServersTable, eq(mcpServersTable.id, agentMcpServersTable.mcpServerId))
    .where(eq(agentMcpServersTable.agentId, agentRow.id));

  const mcpToolNames: string[] = [];
  for (const ms of mcpAssignments) {
    const availableTools = ms.availableTools as McpToolDescriptor[] | null;
    if (!isUsableMcpToolCache(availableTools)) continue; // no live connect — see module doc
    const toolset = createLazyMcpTools(
      { transport: 'stdio', slug: ms.slug, command: '__never_spawned__', args: [], env: {} },
      availableTools,
    );
    const enabled = ms.enabledTools as string[] | null;
    const prefixLen = slugToPrefix(ms.slug).length + 2;
    const filtered =
      enabled === null
        ? toolset.tools
        : toolset.tools.filter((t) => enabled.includes(t.name.slice(prefixLen)));
    mcpToolNames.push(...filtered.map((t) => t.name));
  }

  const capabilityToolNames = [...connectorToolNames, ...mcpToolNames, ...deliveryToolNames];

  // ── Orchestrator vs worker assembly (mirrors execute.ts:1453-1542) ──────
  if (isOrchestrator) {
    const assignTools = await generateAssignTools(agentRow.id as AgentId, db);
    const [createTaskTool, listTasksTool] = generateTaskTools(agentRow.id as AgentId, db);
    const memoryBuiltins = ALWAYS_ON_TOOLS.filter((n) => n !== 'return_result');
    return new Set<string>([
      ...assignTools.map((t) => t.name),
      createTaskTool.name,
      listTasksTool.name,
      ...memoryBuiltins,
      'return_result',
      ...metaToolNames,
      ...scriptToolNames,
      ...fileWriteToolNames,
      ...capabilityToolNames,
    ]);
  }

  const skillRequiredBuiltins = Array.from(
    new Set(assignedSkillRows.flatMap((r) => r.requiredBuiltins ?? [])),
  ).filter((name) => registry.get(name) !== undefined);
  // See module doc: mirrors execute.ts's own (pre-existing) use of skillId
  // (a UUID FK) as a candidate tool name — filtered to registry membership,
  // in practice never matching, exactly as it does in execute.ts.
  const configuredToolNames = assignedSkillRows
    .map((r) => r.skillId)
    .filter((name): name is string => name !== null && registry.get(name) !== undefined);

  const defs = computeToolWhitelist(
    {
      agentId: agentRow.id,
      configuredTools: configuredToolNames,
      alwaysOn: [
        ...ALWAYS_ON_TOOLS,
        ...skillRequiredBuiltins,
        ...metaToolNames,
        ...scriptToolNames,
        ...fileWriteToolNames,
      ],
    },
    registry,
  );

  const names = new Set<string>(defs.map((d) => d.name));
  for (const n of capabilityToolNames) names.add(n);
  return names;
}
