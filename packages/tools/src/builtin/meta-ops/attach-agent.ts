// meta-ops/attach-agent.ts — attach_agent meta-tool
// Lets the ROOT agent assign an EXISTING agent as its sub-agent.
// riskLevel 'write': additive, not destructive.

import { z } from 'zod';
import { attachAgentToOrchestrator } from '@nodal-agents/db';
import type { ToolDefinition } from '../../types';

const AttachAgentInput = z.object({
  agentSlug: z
    .string()
    .min(1)
    .describe('The slug OR name of an existing agent to assign as your sub-agent.'),
});

type AttachAgentOutput = { ok: true; message: string } | { ok: false; error: string };

export const attachAgentTool: ToolDefinition<typeof AttachAgentInput, AttachAgentOutput> = {
  name: 'attach_agent',
  description:
    'Assign an EXISTING agent as your sub-agent so you can delegate to it. ' +
    'Use this — NOT create_agent — when the agent already exists. ' +
    'Idempotent: safe to call even if the agent is already assigned. ' +
    'Fails with a clear error if the agent is not found in this workspace.',
  inputSchema: AttachAgentInput,
  riskLevel: 'write',
  defaultApproval: 'require_approval',
  execute: async (input, ctx) => {
    const result = await attachAgentToOrchestrator(
      ctx.db,
      ctx.entityId,
      ctx.agentId,
      input.agentSlug,
    );

    if ('error' in result) {
      if (result.error === 'agent_not_found') {
        return {
          ok: false,
          error:
            `No agent named "${input.agentSlug}" in this workspace. ` +
            `Use create_agent to make a new one, or check the name.`,
        };
      }
      // cannot_attach_self
      return {
        ok: false,
        error: `Cannot attach yourself as your own sub-agent.`,
      };
    }

    return {
      ok: true,
      message:
        `Assigned agent "${result.subAgentName}" (id ${result.subAgentId}) as your sub-agent — ` +
        `you can delegate to it now.`,
    };
  },
};
