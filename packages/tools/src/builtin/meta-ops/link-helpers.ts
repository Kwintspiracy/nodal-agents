// meta-ops/link-helpers.ts — shared helpers for attaching infra to an agent.
//
// The runner exposes an agent's MCP/connector tools ONLY via the link tables
// (agent_mcp_servers / agent_connector_assignments). A create_* without the link
// leaves the resource registered but unusable — so create_mcp/create_connector
// and the standalone attach_mcp/attach_connector all go through these.

import {
  eq,
  and,
  asc,
  or,
  ilike,
  agents,
  agentSkills,
  mcpServers,
  connectors,
  attachMcpServerToAgent,
  agentConnectorAssignments,
  findIndistinctAccountOnAgent,
} from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { accountNameKey, indistinctAccountsMessage } from '@nodal-agents/shared';

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

export type ResolveMcpServerResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'ambiguous'; error: string };

/**
 * Resolve an MCP server by slug OR name within an entity.
 *
 * Several rows can answer one word: instances of one catalog server share
 * their slug (allowed since migration 0017), and a name can equal another
 * server's slug. Picking one would attach — or detach — a server nobody chose
 * (#661): the answer is then `ambiguous`, listing each candidate by name and
 * endpoint, so the caller names the one it means.
 */
export async function resolveMcpServerId(
  db: AnyDrizzleDb,
  entityId: string,
  slugOrName: string,
): Promise<ResolveMcpServerResult> {
  const rows = await db
    .select({
      id: mcpServers.id,
      slug: mcpServers.slug,
      name: mcpServers.name,
      url: mcpServers.url,
      command: mcpServers.command,
    })
    .from(mcpServers)
    .where(
      and(
        eq(mcpServers.entityId, entityId),
        or(eq(mcpServers.slug, slugOrName), ilike(mcpServers.name, escapeLikePattern(slugOrName))),
      ),
    )
    .orderBy(mcpServers.createdAt, mcpServers.id);
  if (rows.length === 0) return { ok: false, reason: 'not_found' };
  if (rows.length === 1) return { ok: true, id: rows[0]!.id };
  const listed = rows
    .map((r) => `"${r.name}" (slug ${r.slug}, ${r.url ?? r.command ?? 'no endpoint'})`)
    .join('; ');
  const sameName = new Set(rows.map((r) => r.name.toLowerCase())).size < rows.length;
  return {
    ok: false,
    reason: 'ambiguous',
    error:
      `"${slugOrName}" matches ${rows.length} MCP servers in this workspace: ${listed}. ` +
      (sameName
        ? 'Some share their name too: rename one in the dashboard, then call again with its name.'
        : 'Call again with the name of the one you mean.'),
  };
}

/**
 * List the MCP server slugs actually available in this workspace, bounded
 * (LIMIT 20). Used to enrich a "not found" error with real, guessable-free
 * names — an LLM that hallucinates a slug (e.g. `mcp_fetch` guessed from a
 * tool-name prefix) can self-correct to the real one (`mcp-fetch`) instead
 * of retrying the same wrong guess.
 */
export async function listMcpServerSlugs(
  db: AnyDrizzleDb,
  entityId: string,
  limit = 20,
): Promise<string[]> {
  const rows = await db
    .select({ slug: mcpServers.slug })
    .from(mcpServers)
    .where(eq(mcpServers.entityId, entityId))
    .limit(limit);
  return rows.map((r) => r.slug);
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
        or(
          eq(agentSkills.slug, slugOrName),
          ilike(agentSkills.name, escapeLikePattern(slugOrName)),
        ),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/**
 * Resolve a connector by name OR slug within an entity.
 *
 * A workspace may hold several connectors of one slug (a personal and a work
 * Gmail): a slug then names several, and none is picked for the caller. A
 * name designates the connector that carries it; a slug, the one connector of
 * that slug. When the words designate several, the answer is `ambiguous` with
 * their names, and the caller says so: never the first row the database
 * returns.
 */
export async function resolveConnectorId(
  db: AnyDrizzleDb,
  entityId: string,
  slugOrName: string,
): Promise<{ id: string } | { ambiguous: string[] } | null> {
  const rows = await db
    .select({ id: connectors.id, slug: connectors.slug, name: connectors.name })
    .from(connectors)
    .where(
      and(
        eq(connectors.entityId, entityId),
        or(eq(connectors.slug, slugOrName), ilike(connectors.name, escapeLikePattern(slugOrName))),
      ),
    )
    .orderBy(asc(connectors.name), asc(connectors.id));
  const byName = rows.filter((r) => accountNameKey(r.name) === accountNameKey(slugOrName));
  const candidates = byName.length > 0 ? byName : rows.filter((r) => r.slug === slugOrName);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return { id: candidates[0]!.id };
  return { ambiguous: candidates.map((r) => `"${r.name}" (${r.slug})`) };
}

/** What a caller says when `resolveConnectorId` answered `ambiguous`. */
export function ambiguousConnectorMessage(words: string, candidates: readonly string[]): string {
  return (
    `"${words}" names several connectors of this workspace: ${candidates.join(', ')}. ` +
    `Call again with the name of the one you mean.`
  );
}

/**
 * Link an MCP server to an agent (idempotent: an existing link keeps its tool
 * list). Refused when the server's tool names would collide with a server the
 * agent already holds (#661) — the error says which, and what to do.
 */
export async function linkMcpToAgent(
  db: AnyDrizzleDb,
  entityId: string,
  agentId: string,
  mcpServerId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const attached = await attachMcpServerToAgent(db, { entityId, agentId, mcpServerId });
  return attached.ok ? { ok: true } : { ok: false, error: attached.message };
}

/**
 * Link a connector to an agent (idempotent: an existing link keeps its
 * operations). Refused when the agent already holds another account of the
 * same service under a name a model could not tell apart from this one's:
 * the tools of several accounts take an `account` argument whose values are
 * their names. The error names both connectors.
 */
export async function linkConnectorToAgent(
  db: AnyDrizzleDb,
  entityId: string,
  agentId: string,
  connectorId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const [connector] = await db
    .select({ id: connectors.id, slug: connectors.slug, name: connectors.name })
    .from(connectors)
    .where(and(eq(connectors.id, connectorId), eq(connectors.entityId, entityId)));
  if (!connector) return { ok: false, error: 'Connector not found in this workspace.' };
  const clash = await findIndistinctAccountOnAgent(db, agentId, connector);
  if (clash) return { ok: false, error: indistinctAccountsMessage(connector, clash) };
  await db
    .insert(agentConnectorAssignments)
    .values({ entityId, agentId, connectorId, enabledOperations: null })
    .onConflictDoNothing();
  return { ok: true };
}
