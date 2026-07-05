// agent_jobs table

import {
  pgTable,
  text,
  uuid,
  integer,
  real,
  jsonb,
  timestamp,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { entities } from './entities.ts';
import { agents } from './agents.ts';

export const agentJobs = pgTable(
  'agent_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
    status: text('status').default('pending'),
    channel: text('channel').notNull(),
    task: text('task').notNull(),
    originalTask: text('original_task'),
    chatId: text('chat_id'),
    systemPrompt: text('system_prompt'),
    messages: jsonb('messages').default(sql`'[]'::jsonb`),
    /**
     * Flattened plain-text transcript (task + assistant text + tool outputs +
     * result) for full-text episodic search. Populated at job completion by
     * flattenTranscript(). A generated `search_tsv tsvector` column + GIN index
     * (raw SQL, migration 0050 — not expressible in the Drizzle schema builder)
     * makes it queryable by the `search_history` builtin.
     */
    searchText: text('search_text'),
    toolsUsed: text('tools_used')
      .array()
      .default(sql`'{}'::text[]`),
    turn: integer('turn').default(0),
    result: text('result'),
    error: text('error'),
    chainCount: integer('chain_count').default(0),
    requestId: text('request_id'),
    parentJobId: uuid('parent_job_id'),
    parentRequestId: text('parent_request_id'),
    totalDurationMs: integer('total_duration_ms').default(0),
    inputTokens: integer('input_tokens').default(0),
    outputTokens: integer('output_tokens').default(0),
    /**
     * Cumulative EFFECTIVE (non-cached) input tokens = Σ(inputTokens −
     * cachedInputTokens) per turn. The token budget (Guard 1a) measures this,
     * not raw input, so a job that re-sends a prompt-cached history (cheap, the
     * bulk read from cache) is not penalised as if every re-send were fresh.
     * Persisted alongside input_tokens so the budget stays cumulative across
     * self-chain resumes.
     */
    effectiveInputTokens: integer('effective_input_tokens').default(0),
    /**
     * Cumulative real dollar cost billed to the provider across all turns of
     * this job (sum of per-call costs reported by the provider). Populated only
     * when the provider reports per-call cost (OpenRouter with
     * `usage:{include:true}`); undefined/null for providers that don't report it
     * (Anthropic, Ollama, etc.). Used by the cost-budget guard (Guard 1e) and
     * for cost observability in the dashboard.
     *
     * Stored as a real/float because sub-cent values are common (e.g. $0.00056).
     * Cumulative across self-chain / approval / delegation resumes, exactly like
     * effectiveInputTokens.
     */
    totalCostUsd: real('total_cost_usd').default(0),
    /**
     * The upstream provider that actually served the last LLM call for this job
     * (e.g. 'DeepSeek' when an OpenRouter job was routed to the DeepSeek
     * upstream via provider-order preference). Populated from
     * `providerMetadata.openrouter.provider` on each LLM call; only the last
     * non-empty value is stored. NULL for providers that don't report upstream
     * identity (Anthropic, Ollama, etc.) or when the field was absent.
     */
    servedProvider: text('served_provider'),
    delegationDepth: integer('delegation_depth').default(0),
    /**
     * The slug of the last delegated child that failed on this parent job.
     * Set by `resumeDelegated` when a child returns `{status:'failed'}`, cleared
     * when any subsequent delegation succeeds. The runner uses this to block
     * NAIVE retries (parent re-emitting `assign_<sameSlug>` immediately after a
     * failure) while still allowing FALLBACK strategies (parent emitting
     * `assign_<differentSlug>` after a failure, e.g. note-taker as a fallback
     * after summarizer timeout).
     *
     * Replaces the earlier `failed_delegations_count` global counter from
     * commit `b76d449`, which was too coarse — it blocked ALL further
     * delegations after one failure, including legitimate fallbacks to a
     * different specialist (live regression: job `7767a3c1`, 2026-05-19).
     */
    lastFailedDelegationSlug: text('last_failed_delegation_slug'),
    pendingDelegation: jsonb('pending_delegation'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_agent_jobs_entity_id').on(table.entityId),
    index('idx_agent_jobs_entity_created').on(table.entityId, sql`${table.createdAt} DESC`),
    index('idx_agent_jobs_entity_status_created').on(
      table.entityId,
      table.status,
      sql`${table.createdAt} DESC`,
    ),
    index('idx_agent_jobs_parent_job_id').on(table.parentJobId),
    // idx_jobs_parent (F-20, audit #2) was an exact duplicate of
    // idx_agent_jobs_parent_job_id above — same column, same order, both from
    // migration 0000. Dropped in migration 0054; kept this one (matches the
    // idx_agent_jobs_* naming convention used everywhere else on this table).
    index('idx_jobs_status').on(table.status, table.createdAt),
    // DB-3 (audit #2): findUndeliveredRootJobIds (cron/deliver-results.ts)
    // joins on this column filtered to IS NULL every tick; the cron recovery
    // scans (findPendingJobsToRecover, resetOrphanedJobs, failStalePendingJobs
    // in cron/reset-orphans.ts) also filter by status without an entity_id,
    // which idx_jobs_status (kept above) still serves — completed rows vastly
    // outnumber the still-open ones, so a partial index keyed on the open set
    // stays small regardless of table growth.
    index('idx_agent_jobs_completed_at_null')
      .on(table.completedAt)
      .where(sql`${table.completedAt} IS NULL`),
    check(
      'agent_jobs_status_check',
      sql`${table.status} IN ('pending','processing','completed','failed','awaiting_approval','awaiting_delegation','cancelled')`,
    ),
    check(
      'agent_jobs_channel_check',
      sql`${table.channel} IN ('telegram','api','whatsapp','internal','cron','task-board','slack','discord','dashboard')`,
    ),
  ],
);

// Self-referential FK (parent_job_id) added separately in migration SQL.
export type AgentJobRow = typeof agentJobs.$inferSelect;
export type AgentJobInsert = typeof agentJobs.$inferInsert;
