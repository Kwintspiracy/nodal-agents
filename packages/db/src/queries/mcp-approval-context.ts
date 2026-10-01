// mcp-approval-context.ts — resolve which MCP server is behind a namespaced
// tool name, so an approval card can name it.
//
// Lives here because it is a DB read and only packages/db may touch drizzle
// (dep-cruiser `only-db-imports-pg`), and because BOTH surfaces need it: the
// runner renders channel cards, the dashboard renders the approvals page. One
// implementation keeps the two from drifting — the wording of an approval is
// exactly the kind of thing that silently diverges between surfaces.

import { and, eq } from 'drizzle-orm';
import { isToolOfMcpServer, mcpToolNamespace } from '@nodal-agents/shared';
import { agentMcpServers, mcpServers } from '../schema/mcp';
import type { AnyDrizzleDb } from '../client';

export interface McpApprovalContext {
  slug: string;
  name: string;
  /** URL for http transport, command for stdio. */
  endpoint: string;
  /** Description THIS server supplies for the tool. Third-party text. */
  toolDescription?: string;
  /**
   * The server's own `readOnlyHint`. A HINT, never a security decision — it
   * softens the card's wording; the approval was required regardless.
   */
  readOnlyHint?: boolean;
  /** True when the agent holds several servers this name could belong to (see below). */
  ambiguous: boolean;
  /** The rule pattern that would cover every tool of this server. */
  rulePattern: string;
}

interface DiscoveredTool {
  name?: unknown;
  description?: unknown;
  annotations?: { readOnlyHint?: unknown } | null;
}

/**
 * The MCP server behind `toolName`, among those the requesting agent holds —
 * null when it is a built-in, not a tool of any of them, or the request
 * names no agent.
 *
 * Within the agent, not the workspace (#661): a workspace may hold several
 * instances of one catalog server (same slug, same tool names) for different
 * agents, and only the agent's own attachment says which one it called. An
 * agent never holds two servers whose namespaces overlap (attach paths and
 * runner refuse it), so one server matches; a row written before that rule
 * can still match two, and the result says so (`ambiguous`) instead of
 * silently naming one.
 */
export async function getMcpApprovalContext(
  db: AnyDrizzleDb,
  entityId: string,
  agentId: string | null,
  toolName: string,
): Promise<McpApprovalContext | null> {
  // No agent, no attachment to read: the server is not identified.
  if (!agentId || !toolName.includes('__')) return null;

  const rows = await db
    .select({
      slug: mcpServers.slug,
      name: mcpServers.name,
      url: mcpServers.url,
      command: mcpServers.command,
      transport: mcpServers.transport,
      availableTools: mcpServers.availableTools,
    })
    .from(agentMcpServers)
    .innerJoin(mcpServers, eq(mcpServers.id, agentMcpServers.mcpServerId))
    .where(and(eq(agentMcpServers.agentId, agentId), eq(mcpServers.entityId, entityId)));

  const matches = rows.filter((r) => isToolOfMcpServer(r.slug, toolName));
  const row = matches[0];
  if (!row) return null;
  const namespace = mcpToolNamespace(row.slug);
  const tool = toolName.slice(namespace.length);

  const endpoint =
    row.transport === 'http'
      ? (row.url ?? '(url manquante)')
      : (row.command ?? '(commande manquante)');

  let toolDescription: string | undefined;
  let readOnlyHint: boolean | undefined;
  const tools = Array.isArray(row.availableTools) ? (row.availableTools as DiscoveredTool[]) : [];
  for (const t of tools) {
    if (t && typeof t === 'object' && t.name === tool) {
      if (typeof t.description === 'string') toolDescription = t.description;
      if (typeof t.annotations?.readOnlyHint === 'boolean')
        readOnlyHint = t.annotations.readOnlyHint;
      break;
    }
  }

  return {
    slug: row.slug,
    name: row.name,
    endpoint,
    ...(toolDescription ? { toolDescription } : {}),
    ...(readOnlyHint !== undefined ? { readOnlyHint } : {}),
    ambiguous: matches.length > 1,
    rulePattern: `${namespace}*`,
  };
}
