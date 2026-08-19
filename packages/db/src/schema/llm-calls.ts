// llm_calls — one row per LLM inference call (étape D of the
// subscription-runtimes plan; Lot A of the 2026-08-19 reproducibility audit).
//
// This is the INFERENCE trace Nodal never had: agent_jobs records what the
// agent DID (tool_calls, results); nothing recorded what was SENT to the
// model — which effective model actually answered (the fallback hole:
// a chain link without a model resolves to MODEL_CATALOG[provider][0], so
// reordering the catalog reinterpreted history), which tools were offered,
// what it cost. Written by a sink the RUNNER injects as a callback into
// packages/llm's choke point — packages/llm does NOT depend on packages/db.
//
// Covers every caller in one seam: job loop, dashboard chat (previously
// 100% invisible), curator/reflection, cron. Failures to write are logged,
// never swallowed, and never fail the call itself.

import { pgTable, text, uuid, integer, real, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { entities } from './entities.ts';
import { agents } from './agents.ts';
import { agentJobs } from './jobs.ts';

export const llmCalls = pgTable(
  'llm_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
    // set null: an audit row must survive the deletion of its agent/job.
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    jobId: uuid('job_id').references(() => agentJobs.id, { onDelete: 'set null' }),
    /** Where the call came from: 'job' | 'chat' | 'curator' | 'reflection' | 'cron' | … */
    source: text('source').notNull(),
    /** Job-loop turn number when applicable (null for chat/curator). */
    turn: integer('turn'),
    /** What the caller ASKED for (agent.model / chain link), before resolution. */
    modelRequested: text('model_requested'),
    /** What actually answered — THE fallback-hole closer. Never guessed. */
    modelEffective: text('model_effective').notNull(),
    provider: text('provider').notNull(),
    llmKeyId: uuid('llm_key_id'),
    reasoningEffort: text('reasoning_effort'),
    toolChoice: text('tool_choice'),
    /** Names of the tools OFFERED to the model (not called — offered). */
    toolNames: text('tool_names').array(),
    /** sha256 of the sorted tool-name list — cheap drift detection across calls. */
    toolsHash: text('tools_hash'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cachedTokens: integer('cached_tokens'),
    costUsd: real('cost_usd'),
    durationMs: integer('duration_ms'),
    /** True when this call was served by a fallback link, not the primary. */
    failover: boolean('failover').notNull().default(false),
    /** Terminal error of the call, when it failed (row still written). */
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_llm_calls_job').on(table.jobId, table.createdAt),
    index('idx_llm_calls_entity_created').on(table.entityId, table.createdAt),
    index('idx_llm_calls_agent_created').on(table.agentId, table.createdAt),
  ],
);

export type LlmCallRow = typeof llmCalls.$inferSelect;
export type LlmCallInsert = typeof llmCalls.$inferInsert;
