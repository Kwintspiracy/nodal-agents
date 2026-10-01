// repos/agent-mcp-servers.ts — giving an MCP server to an agent (#661).
//
// The ONE place every attach path goes through: the dashboard's Connectors
// tab, an agent recipe, and `attach_mcp` / `create_mcp` (packages/tools). It
// refuses a server whose tool namespace overlaps one the agent already holds
// (same slug — two instances of one catalog server — or slugs folding onto the
// same prefix): inside a job a tool name must designate ONE server, or the
// call goes to whichever came last and the approval card names another.
//
// Several instances of a server in a workspace stay allowed; each goes to a
// different agent. The runner refuses a job whose agent already holds two
// overlapping servers (rows written before this rule).

import { and, eq, ne } from 'drizzle-orm';
import { mcpNamespaceOverlapMessage, mcpToolNamespacesOverlap } from '@nodal-agents/shared';
import type { AnyDrizzleDb } from '../client.ts';
import { agentMcpServers, mcpServers } from '../schema/mcp.ts';

export type AttachMcpServerResult =
  | { ok: true }
  | { ok: false; reason: 'not_found'; message: string }
  | {
      ok: false;
      reason: 'namespace_overlap';
      message: string;
      /** The server the agent already holds, which the new one would shadow. */
      held: { id: string; slug: string; name: string };
    };

export interface AttachMcpServerInput {
  entityId: string;
  agentId: string;
  mcpServerId: string;
  /**
   * The tools of the server the agent may call (null = all). Left undefined,
   * an existing attachment keeps its own list, and a new one gets all of them.
   */
  enabledTools?: string[] | null;
}

/** Attach `mcpServerId` to `agentId`, unless its tool names would collide. */
export async function attachMcpServerToAgent(
  db: AnyDrizzleDb,
  input: AttachMcpServerInput,
): Promise<AttachMcpServerResult> {
  const { entityId, agentId, mcpServerId, enabledTools } = input;

  const [server] = await db
    .select({ id: mcpServers.id, slug: mcpServers.slug, name: mcpServers.name })
    .from(mcpServers)
    .where(and(eq(mcpServers.id, mcpServerId), eq(mcpServers.entityId, entityId)));
  if (!server) {
    return { ok: false, reason: 'not_found', message: 'MCP server not found in this workspace.' };
  }

  const held = await db
    .select({ id: mcpServers.id, slug: mcpServers.slug, name: mcpServers.name })
    .from(agentMcpServers)
    .innerJoin(mcpServers, eq(mcpServers.id, agentMcpServers.mcpServerId))
    .where(and(eq(agentMcpServers.agentId, agentId), ne(mcpServers.id, mcpServerId)));
  const clash = held.find((h) => mcpToolNamespacesOverlap(h.slug, server.slug));
  if (clash) {
    return {
      ok: false,
      reason: 'namespace_overlap',
      message: mcpNamespaceOverlapMessage(clash, server),
      held: clash,
    };
  }

  const row = { entityId, agentId, mcpServerId, enabledTools: enabledTools ?? null };
  if (enabledTools === undefined) {
    await db.insert(agentMcpServers).values(row).onConflictDoNothing();
  } else {
    await db
      .insert(agentMcpServers)
      .values(row)
      .onConflictDoUpdate({
        target: [agentMcpServers.agentId, agentMcpServers.mcpServerId],
        set: { enabledTools: enabledTools ?? null, updatedAt: new Date() },
      });
  }
  return { ok: true };
}
