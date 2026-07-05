// meta-ops/link-helpers.ts — shared helpers for attaching infra to an agent.
//
// The runner exposes an agent's MCP/connector tools ONLY via the link tables
// (agent_mcp_servers / agent_connector_assignments). A create_* without the link
// leaves the resource registered but unusable — so create_mcp/create_connector
// and the standalone attach_mcp/attach_connector all go through these.

import {
  eq,
  and,
  or,
  ilike,
  agents,
  agentSkills,
  mcpServers,
  connectors,
  agentMcpServers,
  agentConnectorAssignments,
} from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';

/**
 * Escape ILIKE metacharacters (`%`, `_`, `\`) so a `slugOrName` value is
 * matched LITERALLY against `name` — F-10 (audit #2). These resolvers intend
 * an EXACT (case-insensitive) name match, same semantics as the `slug` `eq`
 * branch they're OR'd with; without escaping, a name containing `%` or `_`
 * is interpreted as a wildcard pattern (e.g. "Sales%" matches any name
 * starting with "Sales"), silently resolving to the wrong row within the
 * entity. Postgres' default ILIKE escape character is `\`, so prefixing each
 * metacharacter with it is sufficient — no explicit ESCAPE clause needed.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Resolve an agent by slug OR name within an entity. */
export async function resolveAgentId(
  db: AnyDrizzleDb,
  entityId: string,
  slugOrName: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.entityId, entityId),
        or(eq(agents.slug, slugOrName), ilike(agents.name, escapeLikePattern(slugOrName))),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/** Resolve an MCP server by slug OR name within an entity. */
export async function resolveMcpServerId(
  db: AnyDrizzleDb,
  entityId: string,
  slugOrName: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: mcpServers.id })
    .from(mcpServers)
    .where(
      and(
        eq(mcpServers.entityId, entityId),
        or(eq(mcpServers.slug, slugOrName), ilike(mcpServers.name, escapeLikePattern(slugOrName))),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/** Resolve a skill by slug OR name within an entity. */
export async function resolveSkillId(
  db: AnyDrizzleDb,
  entityId: string,
  slugOrName: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: agentSkills.id })
    .from(agentSkills)
    .where(
      and(
        eq(agentSkills.entityId, entityId),
        or(eq(agentSkills.slug, slugOrName), ilike(agentSkills.name, escapeLikePattern(slugOrName))),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/** Resolve a connector by slug OR name within an entity. */
export async function resolveConnectorId(
  db: AnyDrizzleDb,
  entityId: string,
  slugOrName: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: connectors.id })
    .from(connectors)
    .where(
      and(
        eq(connectors.entityId, entityId),
        or(eq(connectors.slug, slugOrName), ilike(connectors.name, escapeLikePattern(slugOrName))),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/** Link an MCP server to an agent (idempotent). */
export async function linkMcpToAgent(
  db: AnyDrizzleDb,
  entityId: string,
  agentId: string,
  mcpServerId: string,
): Promise<void> {
  await db
    .insert(agentMcpServers)
    .values({ entityId, agentId, mcpServerId, enabledTools: null })
    .onConflictDoNothing();
}

/** Link a connector to an agent (idempotent). */
export async function linkConnectorToAgent(
  db: AnyDrizzleDb,
  entityId: string,
  agentId: string,
  connectorId: string,
): Promise<void> {
  await db
    .insert(agentConnectorAssignments)
    .values({ entityId, agentId, connectorId, enabledOperations: null })
    .onConflictDoNothing();
}
