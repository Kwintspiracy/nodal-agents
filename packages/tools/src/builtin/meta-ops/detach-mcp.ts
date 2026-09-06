// meta-ops/detach-mcp.ts — detach_mcp meta-tool
// Removes an MCP server from an agent (deletes the agent_mcp_servers link).
// riskLevel 'write': reversible (re-attach with attach_mcp).

import { z } from 'zod';
import { eq, and, agentMcpServers } from '@nodal-agents/db';
import type { ToolDefinition } from '../../types';
import { resolveAgentId, resolveMcpServerId } from './link-helpers';

const DetachMcpInput = z.object({
  mcpSlug: z.string().min(1).describe('Slug or name of the MCP server to remove from the agent.'),
  agentSlug: z.string().min(1).describe('Slug or name of the agent to remove the MCP from.'),
});

type DetachMcpOutput = { ok: true; message: string } | { ok: false; error: string };

export const detachMcpTool: ToolDefinition<typeof DetachMcpInput, DetachMcpOutput> = {
  name: 'detach_mcp',
  description:
    'Remove an MCP server from an agent (its tools stop being available to that agent). ' +
    'Reversible with attach_mcp. Idempotent.',
  inputSchema: DetachMcpInput,
  riskLevel: 'write',
  card: 'text',
  defaultApproval: 'require_approval',
  execute: async (input, ctx) => {
    const mcpId = await resolveMcpServerId(ctx.db, ctx.entityId, input.mcpSlug);
    if (!mcpId)
      return { ok: false, error: `MCP server "${input.mcpSlug}" not found in this workspace.` };
    const agentId = await resolveAgentId(ctx.db, ctx.entityId, input.agentSlug);
    if (!agentId)
      return { ok: false, error: `Agent "${input.agentSlug}" not found in this workspace.` };
    await ctx.db
      .delete(agentMcpServers)
      .where(and(eq(agentMcpServers.agentId, agentId), eq(agentMcpServers.mcpServerId, mcpId)));
    return {
      ok: true,
      message: `Removed MCP "${input.mcpSlug}" from agent "${input.agentSlug}".`,
    };
  },
};
