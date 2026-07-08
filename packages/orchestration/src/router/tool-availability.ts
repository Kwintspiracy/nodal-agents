// router/tool-availability.ts — lightweight, no-network estimate of the tool
// NAMES an agent would have available, used ONLY to validate delegation
// briefs at CREATION time (B2, audit#2 followup).
//
// Deliberately cheaper than the runner's real per-job toolset build
// (apps/runner/src/job/execute.ts): it never decrypts connector credentials
// nor connects to an MCP server — it only needs NAMES, derived straight from
// the assignment rows, the same way generateAssignTools (./assign-tools.ts)
// already derives its "Connectors: x, y" description tag without a live
// connection. This is an estimate for a same-turn warning, NOT a substitute
// for computeToolWhitelist — a false negative here just means no warning;
// the runner's real gate is what actually enforces availability.

import { eq } from '@nodal-agents/db';
import {
  agents,
  entities,
  agentSkillAssignments,
  agentSkills,
  agentConnectorAssignments,
  connectors as connectorsTable,
  agentMcpServers,
  mcpServers,
} from '@nodal-agents/db';
import { ADAPTER_REGISTRY } from '@nodal-agents/runner-adapters';
import { ALWAYS_ON_TOOLS, DELIVERY_TOOL_NAMES } from '@nodal-agents/tools';
import { enabledMetaTools, parseRootGrants, META_TOOL_NAMES } from '@nodal-agents/shared';
import type { AgentId, AnyDrizzleDb, EntityId } from '../types';

/**
 * The full universe of FIXED tool names B2 knows how to reason about — a word
 * in a brief only counts as a "tool mention" worth warning about when it's a
 * member of this set. Deliberately excludes MCP tool names (server-specific,
 * no fixed catalog) and per-connector operation slugs (added below, since
 * those DO come from a fixed catalog: ADAPTER_REGISTRY).
 */
export const KNOWN_FIXED_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...ALWAYS_ON_TOOLS,
  ...DELIVERY_TOOL_NAMES,
  ...META_TOOL_NAMES,
  'run_skill_script',
  'skill_file_write',
]);

/** Every connector operation slug across the whole adapter catalog (fixed, static). */
export const KNOWN_CONNECTOR_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.values(ADAPTER_REGISTRY).flatMap((entry) => entry.operations.map((o) => o.slug)),
);

/** The comparison universe for B2: any word matching this set is a real tool name. */
export const KNOWN_TOOL_NAME_UNIVERSE: ReadonlySet<string> = new Set([
  ...KNOWN_FIXED_TOOL_NAMES,
  ...KNOWN_CONNECTOR_TOOL_NAMES,
]);

/**
 * Compute the tool NAMES `agentId` would actually have available, for B2's
 * same-turn brief validation. NOT the runner's real whitelist — no connector
 * decryption, no MCP connect; only what's derivable from assignment rows.
 *
 * @param hasDeliveryRecipient  Whether a run for this agent would carry a
 *   resolvable Telegram chat (job.chatId) — delivery tools are gated on that
 *   in execute.ts (and, per B3, inherited from the entity's root agent for a
 *   delegated worker). Pass `false` for a create_task target: task-board
 *   children never inherit chat_id (apps/runner/src/cron/execute-ready.ts),
 *   so delivery tools are never available to them regardless of B3.
 */
export async function computeAgentToolNames(
  agentId: AgentId,
  entityId: EntityId,
  db: AnyDrizzleDb,
  opts: { hasDeliveryRecipient: boolean },
): Promise<Set<string>> {
  const names = new Set<string>(ALWAYS_ON_TOOLS);

  const [agentRow] = await db
    .select({ telegramBotToken: agents.telegramBotToken })
    .from(agents)
    .where(eq(agents.id, agentId as string))
    .limit(1);

  if (opts.hasDeliveryRecipient) {
    let deliveryToken = agentRow?.telegramBotToken ?? null;
    if (!deliveryToken) {
      // B3 — a delegated worker without its own token inherits the entity's
      // root agent's token. Mirrors execute.ts's resolution exactly (same
      // entity-scoped root lookup), so a brief mentioning send_image for a
      // target that will get it via B3 does NOT get a false-positive warning.
      const [rootRow] = await db
        .select({ telegramBotToken: agents.telegramBotToken })
        .from(entities)
        .innerJoin(agents, eq(agents.id, entities.rootAgentId))
        .where(eq(entities.id, entityId as string))
        .limit(1);
      deliveryToken = rootRow?.telegramBotToken ?? null;
    }
    if (deliveryToken) {
      for (const n of DELIVERY_TOOL_NAMES) names.add(n);
    }
  }

  const skillRows = await db
    .select({
      requiredBuiltins: agentSkills.requiredBuiltins,
      scriptsAuthorized: agentSkillAssignments.scriptsAuthorized,
      filesWritable: agentSkillAssignments.filesWritable,
    })
    .from(agentSkillAssignments)
    .innerJoin(agentSkills, eq(agentSkills.id, agentSkillAssignments.skillId))
    .where(eq(agentSkillAssignments.agentId, agentId as string));
  for (const r of skillRows) {
    for (const n of r.requiredBuiltins ?? []) names.add(n);
    if (r.scriptsAuthorized) names.add('run_skill_script');
    if (r.filesWritable) names.add('skill_file_write');
  }

  const connectorRows = await db
    .select({
      slug: connectorsTable.slug,
      enabledOperations: agentConnectorAssignments.enabledOperations,
    })
    .from(agentConnectorAssignments)
    .innerJoin(connectorsTable, eq(connectorsTable.id, agentConnectorAssignments.connectorId))
    .where(eq(agentConnectorAssignments.agentId, agentId as string));
  for (const r of connectorRows) {
    const entry = ADAPTER_REGISTRY[r.slug];
    if (!entry) continue;
    const allToolNames = entry.operations.map((o) => o.slug);
    const kept =
      r.enabledOperations === null
        ? allToolNames
        : allToolNames.filter((n) => r.enabledOperations!.includes(n));
    for (const n of kept) names.add(n);
  }

  const mcpRows = await db
    .select({
      serverSlug: mcpServers.slug,
      enabledTools: agentMcpServers.enabledTools,
      availableTools: mcpServers.availableTools,
    })
    .from(agentMcpServers)
    .innerJoin(mcpServers, eq(mcpServers.id, agentMcpServers.mcpServerId))
    .where(eq(agentMcpServers.agentId, agentId as string));
  for (const r of mcpRows) {
    const prefix = r.serverSlug.replace(/-/g, '_');
    const available = Array.isArray(r.availableTools)
      ? (r.availableTools as Array<{ name?: unknown }>)
          .map((t) => (t && typeof t.name === 'string' ? t.name : null))
          .filter((n): n is string => n !== null)
      : [];
    const enabled = Array.isArray(r.enabledTools)
      ? new Set((r.enabledTools as unknown[]).filter((n): n is string => typeof n === 'string'))
      : null;
    const kept = enabled === null ? available : available.filter((n) => enabled.has(n));
    for (const n of kept) names.add(`${prefix}__${n}`);
  }

  // ROOT meta-tools — only relevant when this agent IS the entity's root.
  const [entityRow] = await db
    .select({ rootAgentId: entities.rootAgentId, rootGrants: entities.rootGrants })
    .from(entities)
    .where(eq(entities.id, entityId as string))
    .limit(1);
  if (entityRow?.rootAgentId === agentId) {
    for (const n of enabledMetaTools(parseRootGrants(entityRow.rootGrants))) names.add(n);
  }

  return names;
}

/**
 * Scan `briefText` for whole words matching a real tool name (member of
 * `KNOWN_TOOL_NAME_UNIVERSE`) that is NOT in `availableToolNames`. Exact
 * word-boundary match, no NLP — "send_image" is caught, "send an image" or
 * "images" is not.
 */
export function findUnavailableToolMentions(
  briefText: string,
  availableToolNames: ReadonlySet<string>,
): string[] {
  const words = briefText.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [];
  const missing = new Set<string>();
  for (const w of words) {
    if (KNOWN_TOOL_NAME_UNIVERSE.has(w) && !availableToolNames.has(w)) missing.add(w);
  }
  return [...missing];
}
