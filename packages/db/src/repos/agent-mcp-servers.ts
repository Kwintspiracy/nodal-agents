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
// different agent.
//
// A NEW attachment is held to the namespace rule, strict on purpose, stricter
// than the runner: what a server lends moves on its own (it publishes a new
// tool, a whitelist widens), so two overlapping namespaces on one agent are a
// collision waiting to happen.
//
// An EXISTING attachment — a pair written before this rule — is judged by the
// names it lends, the rule the runner refuses a job by
// (`findMcpToolNameCollision`): its whitelist may change as long as it lends
// no name another server of the agent lends. That is the way out of a refused
// job besides detaching one: untick the shared tool on one of them. A list the
// database does not know (`null`) proves nothing, and counts as the whole
// namespace.

import { and, eq, ne } from 'drizzle-orm';
import {
  mcpExposedToolNames,
  mcpNamespaceOverlapMessage,
  mcpToolNameCollisionMessage,
  mcpToolNamespacesOverlap,
  isToolOfMcpServer,
} from '@nodal-agents/shared';
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
    .select({
      id: mcpServers.id,
      slug: mcpServers.slug,
      name: mcpServers.name,
      availableTools: mcpServers.availableTools,
    })
    .from(mcpServers)
    .where(and(eq(mcpServers.id, mcpServerId), eq(mcpServers.entityId, entityId)));
  if (!server) {
    return { ok: false, reason: 'not_found', message: 'MCP server not found in this workspace.' };
  }

  const [existing] = await db
    .select({ enabledTools: agentMcpServers.enabledTools })
    .from(agentMcpServers)
    .where(and(eq(agentMcpServers.agentId, agentId), eq(agentMcpServers.mcpServerId, mcpServerId)));
  // Already held, list kept: nothing changes, nothing to judge.
  if (existing && enabledTools === undefined) return { ok: true };

  const held = (
    await db
      .select({
        id: mcpServers.id,
        slug: mcpServers.slug,
        name: mcpServers.name,
        availableTools: mcpServers.availableTools,
        enabledTools: agentMcpServers.enabledTools,
      })
      .from(agentMcpServers)
      .innerJoin(mcpServers, eq(mcpServers.id, agentMcpServers.mcpServerId))
      .where(and(eq(agentMcpServers.agentId, agentId), ne(mcpServers.id, mcpServerId)))
  ).filter((h) => mcpToolNamespacesOverlap(h.slug, server.slug));

  if (!existing) {
    const clash = held[0];
    if (clash) {
      return {
        ok: false,
        reason: 'namespace_overlap',
        message: mcpNamespaceOverlapMessage(clash, server),
        held: { id: clash.id, slug: clash.slug, name: clash.name },
      };
    }
  } else {
    // An existing attachment changes its list: judged by the names it lends.
    const lends = mcpExposedToolNames(server.slug, server.availableTools, enabledTools ?? null);
    for (const h of held) {
      const theirs = mcpExposedToolNames(
        h.slug,
        h.availableTools,
        (h.enabledTools as string[] | null) ?? null,
      );
      const shared =
        lends === null
          ? (theirs ?? []).find((n) => isToolOfMcpServer(server.slug, n))
          : lends.find((n) =>
              theirs === null ? isToolOfMcpServer(h.slug, n) : theirs.includes(n),
            );
      const unknownBoth = lends === null && theirs === null;
      if (shared !== undefined || unknownBoth) {
        const clash = { id: h.id, slug: h.slug, name: h.name };
        return {
          ok: false,
          reason: 'namespace_overlap',
          message:
            shared !== undefined
              ? mcpToolNameCollisionMessage(shared, clash, server)
              : mcpNamespaceOverlapMessage(clash, server),
          held: clash,
        };
      }
    }
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
