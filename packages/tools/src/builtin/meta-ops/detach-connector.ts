// meta-ops/detach-connector.ts — detach_connector meta-tool
// Removes a connector from an agent (deletes the agent_connector_assignments link).
// riskLevel 'write': reversible (re-attach with attach_connector).

import { z } from 'zod';
import { eq, and, agentConnectorAssignments } from '@nodal-agents/db';
import type { ToolDefinition } from '../../types';
import { resolveAgentId, resolveConnectorId } from './link-helpers';

const DetachConnectorInput = z.object({
  connectorSlug: z
    .string()
    .min(1)
    .describe('Slug or name of the connector to remove from the agent.'),
  agentSlug: z.string().min(1).describe('Slug or name of the agent to remove the connector from.'),
});

type DetachConnectorOutput = { ok: true; message: string } | { ok: false; error: string };

export const detachConnectorTool: ToolDefinition<
  typeof DetachConnectorInput,
  DetachConnectorOutput
> = {
  name: 'detach_connector',
  description:
    'Remove a connector from an agent (its operations stop being available to that agent). ' +
    'Reversible with attach_connector. Idempotent.',
  inputSchema: DetachConnectorInput,
  riskLevel: 'write',
  card: 'text',
  defaultApproval: 'require_approval',
  execute: async (input, ctx) => {
    const connectorId = await resolveConnectorId(ctx.db, ctx.entityId, input.connectorSlug);
    if (!connectorId)
      return {
        ok: false,
        error: `Connector "${input.connectorSlug}" not found in this workspace.`,
      };
    const agentId = await resolveAgentId(ctx.db, ctx.entityId, input.agentSlug);
    if (!agentId)
      return { ok: false, error: `Agent "${input.agentSlug}" not found in this workspace.` };
    await ctx.db
      .delete(agentConnectorAssignments)
      .where(
        and(
          eq(agentConnectorAssignments.agentId, agentId),
          eq(agentConnectorAssignments.connectorId, connectorId),
        ),
      );
    return {
      ok: true,
      message: `Removed connector "${input.connectorSlug}" from agent "${input.agentSlug}".`,
    };
  },
};
