// meta-ops/detach-agent.ts — detach_agent meta-tool
// Removes a sub-agent from YOUR team (deletes the agent_assignments link where
// you are the orchestrator). riskLevel 'write': reversible (re-attach with attach_agent).

import { z } from 'zod';
import { eq, and, agentAssignments } from '@nodal-agents/db';
import type { ToolDefinition } from '../../types';
import { resolveAgentId } from './link-helpers';

const DetachAgentInput = z.object({
  agentSlug: z
    .string()
    .min(1)
    .describe('Slug or name of the sub-agent to remove from your team (un-delegate).'),
});

type DetachAgentOutput = { ok: true; message: string } | { ok: false; error: string };

export const detachAgentTool: ToolDefinition<typeof DetachAgentInput, DetachAgentOutput> = {
  name: 'detach_agent',
  description:
    'Remove a sub-agent from your team (stop being able to delegate to it). The agent itself is ' +
    'NOT deleted — only the assignment under you. Reversible with attach_agent. Idempotent.',
  inputSchema: DetachAgentInput,
  riskLevel: 'write',
  execute: async (input, ctx) => {
    const subAgentId = await resolveAgentId(ctx.db, ctx.entityId, input.agentSlug);
    if (!subAgentId)
      return { ok: false, error: `Agent "${input.agentSlug}" not found in this workspace.` };
    await ctx.db
      .delete(agentAssignments)
      .where(
        and(
          eq(agentAssignments.orchestratorId, ctx.agentId),
          eq(agentAssignments.subAgentId, subAgentId),
        ),
      );
    return {
      ok: true,
      message: `Removed sub-agent "${input.agentSlug}" from your team (the agent still exists).`,
    };
  },
};
