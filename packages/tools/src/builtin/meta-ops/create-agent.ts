// meta-ops/create-agent.ts — create_agent meta-tool
// Lets the ROOT agent create new agents in the entity.
// riskLevel 'write': additive, not destructive.
//
// UX-level role mapping (inline — do NOT import from apps/web):
//   'worker'  → role: 'agent',          orchestratorMode: null
//   'router'  → role: 'orchestrator',   orchestratorMode: 'router'
//   'planner' → role: 'orchestrator',   orchestratorMode: 'planner'

import { z } from 'zod';
import { eq, createAgentRepo } from '@nodal-agents/db';
import { agents } from '@nodal-agents/db';
import type { ToolDefinition } from '../../types';

const CreateAgentInput = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens only.')
    .min(1)
    .describe('URL-safe identifier for the agent (e.g. "support-bot").'),
  name: z.string().min(1).describe('Human-readable display name for the agent.'),
  personality: z
    .string()
    .min(1)
    .describe('System prompt / personality instructions for the agent.'),
  model: z.string().min(1).describe('LLM model identifier (e.g. "claude-sonnet-4-6-20260217").'),
  role: z
    .enum(['worker', 'router', 'planner'])
    .describe(
      'Agent role: worker = standard task-running agent; router = orchestrator that routes to sub-agents; planner = orchestrator that plans and delegates.',
    ),
  subAgentSlugs: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Slugs of existing agents to assign as sub-agents (for router/planner roles). Optional.',
    ),
});

type CreateAgentOutput = { ok: true; message: string } | { ok: false; error: string };

/**
 * Map UX-level role to DB-level (role, orchestratorMode).
 * Inline here — mirrors the mapping in apps/web but not imported from it
 * to keep packages/tools independent of apps/web (architecture rule).
 */
function mapRole(role: 'worker' | 'router' | 'planner'): {
  dbRole: 'agent' | 'orchestrator';
  orchestratorMode: 'router' | 'planner' | null;
} {
  switch (role) {
    case 'worker':
      return { dbRole: 'agent', orchestratorMode: null };
    case 'router':
      return { dbRole: 'orchestrator', orchestratorMode: 'router' };
    case 'planner':
      return { dbRole: 'orchestrator', orchestratorMode: 'planner' };
  }
}

export const createAgentTool: ToolDefinition<typeof CreateAgentInput, CreateAgentOutput> = {
  name: 'create_agent',
  description:
    'Create a new agent in this entity. ' +
    'role can be "worker" (standard), "router" (delegates to sub-agents by task type), or "planner" (plans and coordinates sub-agents). ' +
    'Optionally provide subAgentSlugs to wire up sub-agents immediately (router/planner roles). ' +
    'Fails with a clear error if the slug is already taken or a subAgentSlug is not found.',
  inputSchema: CreateAgentInput,
  riskLevel: 'write',
  execute: async (input, ctx) => {
    // Resolve subAgentSlugs → IDs within this entity (if provided)
    let subAgentIds: string[] = [];
    if (input.subAgentSlugs && input.subAgentSlugs.length > 0) {
      const rows = await ctx.db
        .select({ id: agents.id, slug: agents.slug })
        .from(agents)
        .where(eq(agents.entityId, ctx.entityId));

      const bySlug = new Map(rows.map((r) => [r.slug, r.id]));

      const missing = input.subAgentSlugs.filter((s) => !bySlug.has(s));
      if (missing.length > 0) {
        return {
          ok: false,
          error: `Sub-agent slug(s) not found in this entity: ${missing.join(', ')}.`,
        };
      }
      subAgentIds = input.subAgentSlugs.map((s) => bySlug.get(s)!);
    }

    const { dbRole, orchestratorMode } = mapRole(input.role);

    let result;
    try {
      result = await createAgentRepo(ctx.db, ctx.entityId, {
        slug: input.slug,
        name: input.name,
        personality: input.personality,
        model: input.model,
        llmKeyId: null,
        role: dbRole,
        orchestratorMode,
        avatarUrl: null,
        subAgentIds,
        assignToOrchestratorId: ctx.agentId,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'sub_agents_not_found') {
        return {
          ok: false,
          error: 'One or more sub-agent IDs could not be verified. Check subAgentSlugs.',
        };
      }
      throw err;
    }

    if ('error' in result) {
      return {
        ok: false,
        error: `Agent slug "${input.slug}" is already taken. Choose a different slug.`,
      };
    }

    return {
      ok: true,
      message: `Created agent "${input.name}" (${input.slug}), role ${input.role}, id ${result.id} — assigned to your team; you can delegate to it now.`,
    };
  },
};
