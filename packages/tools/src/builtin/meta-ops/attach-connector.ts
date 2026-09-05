// meta-ops/attach-connector.ts — attach_connector meta-tool
// Links an EXISTING connector to an agent so the agent can use its operations.
// Without this link the runner never exposes the connector's tools to the agent.
// riskLevel 'write': additive, idempotent.

import { z } from 'zod';
import type { ToolDefinition } from '../../types';
import { resolveAgentId, resolveConnectorId, linkConnectorToAgent } from './link-helpers';

const AttachConnectorInput = z.object({
  connectorSlug: z
    .string()
    .min(1)
    .describe('Slug or name of the connector to attach (e.g. "notion").'),
  agentSlug: z
    .string()
    .min(1)
    .describe('Slug or name of the agent to give the connector tools to.'),
});

type AttachConnectorOutput = { ok: true; message: string } | { ok: false; error: string };

export const attachConnectorTool: ToolDefinition<
  typeof AttachConnectorInput,
  AttachConnectorOutput
> = {
  name: 'attach_connector',
  description:
    'Attach an EXISTING connector to an agent so its operations become usable by that agent. ' +
    'Both connectorSlug and agentSlug must already exist (use create_connector first if needed). ' +
    'Idempotent. This is the step that actually makes a connector usable — creating it is not enough.',
  inputSchema: AttachConnectorInput,
  riskLevel: 'write',
  card: 'text',
  defaultApproval: 'require_approval',
  execute: async (input, ctx) => {
    const connectorId = await resolveConnectorId(ctx.db, ctx.entityId, input.connectorSlug);
    if (!connectorId) {
      return {
        ok: false,
        error: `Connector "${input.connectorSlug}" not found in this workspace. Create it with create_connector first.`,
      };
    }
    const agentId = await resolveAgentId(ctx.db, ctx.entityId, input.agentSlug);
    if (!agentId) {
      return { ok: false, error: `Agent "${input.agentSlug}" not found in this workspace.` };
    }
    await linkConnectorToAgent(ctx.db, ctx.entityId, agentId, connectorId);
    return {
      ok: true,
      message: `Attached connector "${input.connectorSlug}" to agent "${input.agentSlug}" — its tools are now available to that agent.`,
    };
  },
};
