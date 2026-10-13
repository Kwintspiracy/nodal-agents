// router/assign-tools.ts — generate assign_* tools from DB
// Reads children from agent_assignments table. Never hardcodes agent slugs.

import { z } from 'zod';
import { eq, and } from '@nodal-agents/db';
import { agents, agentAssignments } from '@nodal-agents/db';
import { DelegationPendingError } from '../errors';
import { delegationCard } from '@nodal-agents/tools';
import type { AgentId, AnyDrizzleDb, ToolDefinition, ChildAgent } from '../types';

// ─── Input schema for every assign_* tool ────────────────────────────────────

const assignInputSchema = z.object({
  task: z.string().describe('What this agent should do. Be specific and complete.'),
  data: z
    .string()
    .optional()
    .describe(
      'Data from a previous step to pass to this agent (e.g. spreadsheet content, search results).',
    ),
});

export type AssignInput = z.infer<typeof assignInputSchema>;

// ─── generateAssignTools ──────────────────────────────────────────────────────

/**
 * Generate one `assign_<slug>` tool per child agent of `parentAgentId`.
 *
 * Children are read from `agent_assignments` + `agents` tables.
 * Tool names are always `assign_<slug>` where slug has hyphens replaced by
 * underscores (e.g. `email-bot` → `assign_email_bot`).
 *
 * Each tool's execute() creates the child job, then throws DelegationPendingError
 * to signal to the runner that the parent must suspend.
 *
 * The runner catches DelegationPendingError and calls handleDelegation() to:
 *   1. Suspend the parent job (awaiting_delegation)
 *   2. Store pending_delegation metadata
 *
 * @param parentAgentId  The orchestrator's agent ID
 * @param db             Drizzle DB handle
 * @returns              Array of ToolDefinition — one per active child
 */
/**
 * Distil an agent's personality into a one-line "what it's for" so the
 * orchestrator can route by specialization — the `Purpose` of a roster entry
 * (team-block.ts). Takes the first 1–2 sentences of the personality (which
 * conventionally open with "You are X, a <role>…"), stripped of markdown and
 * capped — enough to convey the agent's vocation without dumping the whole
 * prompt into the roster.
 */
export function summarizePurpose(personality: string | null | undefined, maxLen = 240): string {
  if (!personality) return '';
  // Take the lead paragraph (up to the first blank line / markdown header).
  const lead = personality.split(/\n\s*\n|\n#/)[0] ?? '';
  // Collapse whitespace and strip markdown emphasis/bullets.
  const clean = lead
    .replace(/[*_`#>-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';
  if (clean.length <= maxLen) return clean;
  // Cut at the last sentence boundary before the cap, else hard-cap with an ellipsis.
  const slice = clean.slice(0, maxLen);
  const lastStop = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '));
  return (lastStop > 60 ? slice.slice(0, lastStop + 1) : slice.trimEnd() + '…').trim();
}

export async function generateAssignTools(
  parentAgentId: AgentId,
  db: AnyDrizzleDb,
): Promise<ToolDefinition<typeof assignInputSchema, never>[]> {
  const rows = await db
    .select({ agentName: agents.name, agentSlug: agents.slug })
    .from(agentAssignments)
    .innerJoin(agents, eq(agentAssignments.subAgentId, agents.id))
    .where(
      and(eq(agentAssignments.orchestratorId, parentAgentId as string), eq(agents.active, true)),
    );

  const tools: ToolDefinition<typeof assignInputSchema, never>[] = [];

  for (const row of rows) {
    const { agentName, agentSlug } = row;

    // Normalize slug: hyphens → underscores for valid tool names
    const toolSlug = agentSlug.replace(/-/g, '_');
    const toolName = `assign_${toolSlug}`;

    // The tool is the HANDLE, the roster is the DESCRIPTION. `## Your team`
    // (team-block.ts) describes each teammate — purpose, skills, connectors,
    // folders, shell, the owner's instructions — and names this very tool on
    // its entry, so the description says who it reaches and nothing more. It
    // used to recopy part of the roster (purpose, skills, connectors,
    // instructions) and the delegation scope rule, in every assign_* tool:
    // ~11k characters of eager schemas per turn on a root with ten teammates,
    // half of them said twice (lot 2, PR C2). The name comes from the base
    // (invariant #1).
    const description = `Assign a task to ${agentName}.`;

    // Capture in closure
    const capturedSlug = agentSlug;

    const tool: ToolDefinition<typeof assignInputSchema, never> = {
      name: toolName,
      description,
      // Le texte que lit le PROPRIÉTAIRE (issue #382), construit du nom en base
      // comme la description : un outil de délégation par sous-agent, jamais une
      // table de libellés écrite à la main (invariant #1).
      label: `Delegate to ${agentName}`,
      summary: `Hand a task to ${agentName} and wait for the answer before going on.`,
      inputSchema: assignInputSchema,
      riskLevel: 'write',
      loading: 'eager',
      // Un travail confié à un autre agent : la conversation le rend comme un
      // groupe indenté portant les actes de l'enfant (P1, `ToolCard`).
      card: 'delegation',
      // La charge utile de la carte : qui reçoit, quoi. La réponse de l'enfant
      // n'existe pas encore quand ce présentateur est appelé — execute() lève
      // avant toute ligne d'audit ; l'écran lit le sous-job par parent_job_id.
      present: ({ input }) =>
        delegationCard({ to: agentName, task: input.task, ok: true, resultText: null }),
      // execute() throws DelegationPendingError — the runner must intercept this
      // and call handleDelegation() to suspend the parent and create the child job.
      // The tool never actually returns a value; the signal IS the error.
      execute: async (input: AssignInput) => {
        // This execute is a sentinel — the runner intercepts DelegationPendingError
        // before it propagates. The child job ID will be set by handleDelegation().
        throw new DelegationPendingError(
          // placeholder — handleDelegation will override with the real child job ID
          `pending:${capturedSlug}`,
          capturedSlug,
        );

        // Unreachable — typed as `never` return
        return input as never;
      },
    };

    tools.push(tool);
  }

  return tools;
}

// ─── getChildAgents ───────────────────────────────────────────────────────────

/**
 * Load child agents for a parent orchestrator from the DB.
 * Used by buildTeamBlock and detectOrchestratorMode.
 */
export async function getChildAgents(
  parentAgentId: AgentId,
  db: AnyDrizzleDb,
): Promise<ChildAgent[]> {
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      slug: agents.slug,
      role: agents.role,
      active: agents.active,
    })
    .from(agentAssignments)
    .innerJoin(agents, eq(agentAssignments.subAgentId, agents.id))
    .where(
      and(eq(agentAssignments.orchestratorId, parentAgentId as string), eq(agents.active, true)),
    );

  return rows.map((r) => ({
    id: r.id as AgentId,
    name: r.name,
    slug: r.slug,
    role: r.role as 'agent' | 'orchestrator' | 'system',
    description: r.name, // will be enriched by team-block.ts
  }));
}
