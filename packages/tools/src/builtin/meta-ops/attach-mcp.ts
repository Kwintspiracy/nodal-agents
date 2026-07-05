// meta-ops/attach-mcp.ts — attach_mcp meta-tool
// Links an EXISTING MCP server to an agent so the agent can use its tools.
// Without this link the runner never exposes the server's tools to the agent.
// riskLevel 'write': additive, idempotent.

import { z } from 'zod';
import type { ToolDefinition } from '../../types';
import { resolveAgentId, resolveMcpServerId, linkMcpToAgent } from './link-helpers';

const AttachMcpInput = z.object({
  mcpSlug: z
    .string()
    .min(1)
    .describe('Slug or name of the MCP server to attach (e.g. "my-mcp-server").'),
  agentSlug: z.string().min(1).describe('Slug or name of the agent to give the MCP tools to.'),
});

type AttachMcpOutput = { ok: true; message: string } | { ok: false; error: string };

export const attachMcpTool: ToolDefinition<typeof AttachMcpInput, AttachMcpOutput> = {
  name: 'attach_mcp',
  description:
    'Attach an EXISTING MCP server to an agent so its tools become usable by that agent. ' +
    'Both mcpSlug and agentSlug must already exist (use create_mcp first if needed). ' +
    'Idempotent. This is the step that actually makes an MCP usable — creating it is not enough.',
  inputSchema: AttachMcpInput,
  riskLevel: 'write',
  defaultApproval: 'require_approval',
  execute: async (input, ctx) => {
    const mcpId = await resolveMcpServerId(ctx.db, ctx.entityId, input.mcpSlug);
    if (!mcpId) {
      return {
        ok: false,
        error: `MCP server "${input.mcpSlug}" not found in this workspace. Create it with create_mcp first.`,
      };
    }
    const agentId = await resolveAgentId(ctx.db, ctx.entityId, input.agentSlug);
    if (!agentId) {
      return { ok: false, error: `Agent "${input.agentSlug}" not found in this workspace.` };
    }
    await linkMcpToAgent(ctx.db, ctx.entityId, agentId, mcpId);
    return {
      ok: true,
      message: `Attached MCP "${input.mcpSlug}" to agent "${input.agentSlug}" — its tools are now available to that agent.`,
    };
  },
};
