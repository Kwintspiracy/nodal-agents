// mcp-tool-names.ts — the MCP tool names a job of this agent is lent, read
// from the database without connecting to anything.
//
// The same rule every reader of the stored lists follows (`mcpExposedToolNames`,
// #661): each attached server's own list (`available_tools`), narrowed by the
// agent's `enabled_tools`, under the server's namespace. A server whose list
// was never stored names nothing: only a connection would know its tools.
//
// For callers that build a job's prompt without running the job — the Root
// context preview — so that it carries what the job carries: without these
// names, the guidance of the root's MCP servers never showed in the preview
// (Codex review pass 4 of #659).

import { eq, agentMcpServers, mcpServers } from '@nodal-agents/db';
import { mcpExposedToolNames } from '@nodal-agents/shared';
import type { AnyDrizzleDb } from './types';

export async function resolveMcpToolNames(db: AnyDrizzleDb, agentId: string): Promise<string[]> {
  const attached = await db
    .select({
      slug: mcpServers.slug,
      availableTools: mcpServers.availableTools,
      enabledTools: agentMcpServers.enabledTools,
    })
    .from(agentMcpServers)
    .innerJoin(mcpServers, eq(mcpServers.id, agentMcpServers.mcpServerId))
    .where(eq(agentMcpServers.agentId, agentId));
  return attached.flatMap(
    (ms) =>
      mcpExposedToolNames(
        ms.slug,
        ms.availableTools,
        // jsonb: not a list means no narrowing, as system-prompt.ts reads it.
        Array.isArray(ms.enabledTools)
          ? ms.enabledTools.filter((t): t is string => typeof t === 'string')
          : null,
      ) ?? [],
  );
}
