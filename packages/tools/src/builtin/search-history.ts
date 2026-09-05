// Built-in: search_history
// Full-text (episodic) search over the entity's PAST jobs/conversations. The
// transcript of every completed/failed job is flattened into agent_jobs.search_text
// with a generated search_tsv tsvector + GIN index (migration 0050). This tool is
// the "pull" tier of memory: knowledge that lives OUT of the prompt, retrieved on
// demand at zero standing context cost — unlike the injected memory budget.
//
// Entity-scoped: an agent can recall what ANY teammate did/said/found in this
// workspace. Read-only.

import { z } from 'zod';
import { agentJobs, agents, eq, and, desc, sql } from '@nodal-agents/db';
import type { ToolDefinition } from '../types';
import { searchCard } from '../presenters';

export const SearchHistoryInputSchema = z.object({
  query: z
    .string()
    .min(2)
    .max(200)
    .describe(
      'Keywords to find in past jobs/conversations of this workspace (their task, ' +
        'replies, and tool output). E.g. "z_image workflow port", "Airtable base id", ' +
        '"email sent to the client".',
    ),
  limit: z.number().int().min(1).max(20).optional().describe('Max results to return. Default 6.'),
});

export type SearchHistoryInput = z.infer<typeof SearchHistoryInputSchema>;

export interface HistoryHit {
  job_id: string;
  agent: string | null;
  channel: string | null;
  when: Date | null;
  task: string;
  snippet: string;
}

export const searchHistoryTool: ToolDefinition<typeof SearchHistoryInputSchema, HistoryHit[]> = {
  name: 'search_history',
  description:
    "Search this workspace's PAST jobs and conversations by keyword (full-text). Use it to " +
    'recall what was decided, found, or done before — including by OTHER agents in this ' +
    'workspace (e.g. "what ComfyUI port did we use?", "the brief we wrote last week"). Returns ' +
    'matching past tasks with a highlighted snippet. This is durable recall with no budget ' +
    'limit — reach for it when the answer is likely in past work but not in your injected memory.',
  inputSchema: SearchHistoryInputSchema,
  riskLevel: 'read',
  card: 'search',
  present: ({ input, output }) =>
    searchCard({
      query: input.query,
      hits: output.map((h) => ({ title: h.task, ref: h.job_id, snippet: h.snippet })),
    }),
  execute: async (input, ctx) => {
    const limit = input.limit ?? 6;
    // Parameterized — drizzle binds ${...}; no SQL injection surface.
    const tsq = sql`plainto_tsquery('simple', ${input.query})`;
    const tsv = sql`"agent_jobs"."search_tsv"`;

    const rows = await ctx.db
      .select({
        job_id: agentJobs.id,
        agent: agents.slug,
        channel: agentJobs.channel,
        when: agentJobs.createdAt,
        task: agentJobs.task,
        snippet: sql<string>`ts_headline('simple', coalesce(${agentJobs.searchText}, ${agentJobs.task}, ''), ${tsq}, 'StartSel=«, StopSel=», MaxFragments=2, MinWords=4, MaxWords=18, FragmentDelimiter= … ')`,
      })
      .from(agentJobs)
      .leftJoin(agents, eq(agents.id, agentJobs.agentId))
      .where(and(eq(agentJobs.entityId, ctx.entityId), sql`${tsv} @@ ${tsq}`))
      .orderBy(sql`ts_rank(${tsv}, ${tsq}) DESC`, desc(agentJobs.createdAt))
      .limit(limit);

    return rows.map((r) => ({
      job_id: r.job_id as string,
      agent: r.agent ?? null,
      channel: r.channel ?? null,
      when: r.when ? new Date(r.when as unknown as string | number | Date) : null,
      task: r.task,
      snippet: r.snippet,
    }));
  },
};
