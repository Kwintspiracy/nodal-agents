// cli_runs + workspace_locks — audit and coordination for code_task (étape B
// of the subscription-runtimes plan).
//
// cli_runs: one row per external coding-CLI invocation (claude -p / codex
// exec). This is what the per-agent daily budget sums over and what the
// dashboard's per-source consumption reads. Deliberately SEPARATE from
// agent_jobs.total_cost_usd: that column is re-seeded into an in-memory
// accumulator on every job resume (apps/runner/src/job/execute.ts), so a tool
// writing to it would collide with the runner's own bookkeeping.
//
// workspace_locks: at most one WRITE-mode CLI run per workspace at a time.
// Advisory locks are avoided on purpose — the unit/arch suites run on pglite
// (single connection, no real session locks); the repo-house pattern is the
// atomic conditional INSERT/UPDATE (see apps/runner/src/approvals/resolve.ts).

import {
  pgTable,
  text,
  uuid,
  integer,
  real,
  timestamp,
  index,
  check,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { entities } from './entities.ts';
import { agents } from './agents.ts';
import { agentJobs } from './jobs.ts';

export const cliRuns = pgTable(
  'cli_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
    // set null (not cascade): cli_runs is an audit/consumption record — it must
    // survive the deletion of the agent or job that produced it.
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    jobId: uuid('job_id').references(() => agentJobs.id, { onDelete: 'set null' }),
    provider: text('provider').notNull(),
    mode: text('mode').notNull(),
    /**
     * Which pool paid for the run. 'subscription' = the CLI's own login (the
     * only mode étape B ships); 'api' = an injected API key (étape E fallback).
     * Determined by whether WE injected a key into the spawn env — never
     * guessed after the fact (A-bis finding 1: an env key silently overrides
     * the OAuth login, so presence-at-spawn is the only reliable signal).
     */
    source: text('source').notNull().default('subscription'),
    /** claude session_id / codex thread_id — the resume handle. */
    sessionId: text('session_id'),
    /** Model/effort EXPLICITLY requested (input > agent default). NULL = CLI default. */
    model: text('model'),
    effort: text('effort'),
    /** Notional USD cost (claude reports it even under subscription; codex: null). */
    costUsd: real('cost_usd'),
    /** NON-cached input (le CLI rapporte input_tokens HORS cache — l'inverse de llm_calls). */
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    /** Lectures de cache (cache_read_input_tokens). */
    cachedTokens: integer('cached_tokens'),
    /**
     * Écritures de cache (cache_creation_input_tokens) — le poste de coût
     * dominant d'un run CLI (facturé 1,25× l'input). NULL = donnée absente
     * (run antérieur à 0077, ou codex qui ne l'expose pas) — jamais 0 deviné.
     */
    cacheCreationTokens: integer('cache_creation_tokens'),
    durationMs: integer('duration_ms'),
    cliVersion: text('cli_version'),
    exitCode: integer('exit_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    // The budget query: SUM(cost_usd) per agent since midnight.
    index('idx_cli_runs_agent_created').on(table.agentId, table.createdAt),
    index('idx_cli_runs_entity_id').on(table.entityId),
    check('cli_runs_provider_check', sql`${table.provider} IN ('claude', 'codex')`),
    check('cli_runs_mode_check', sql`${table.mode} IN ('read', 'write')`),
    check('cli_runs_source_check', sql`${table.source} IN ('subscription', 'api')`),
  ],
);

export type CliRunRow = typeof cliRuns.$inferSelect;
export type CliRunInsert = typeof cliRuns.$inferInsert;

// ─── workspace_locks ─────────────────────────────────────────────────────────

export const workspaceLocks = pgTable('workspace_locks', {
  /** Absolute workspace path — the lock's identity (PK ⇒ one holder max). */
  workspacePath: text('workspace_path').primaryKey(),
  jobId: uuid('job_id').notNull(),
  agentId: uuid('agent_id'),
  acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull().defaultNow(),
});

export type WorkspaceLockRow = typeof workspaceLocks.$inferSelect;
export type WorkspaceLockInsert = typeof workspaceLocks.$inferInsert;

// ─── cli_sessions ────────────────────────────────────────────────────────────
//
// Session continuity for RUNTIME agents (étape E): one row per
// (agent, conversation) holding the coding CLI's session/thread id, so the
// next inbound message on that conversation resumes the SAME CLI session
// (`claude --resume <id>`) instead of starting cold.

export const cliSessions = pgTable(
  'cli_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** conversationId (dashboard chat / job grouping) or the channel chatId. */
    conversationKey: text('conversation_key').notNull(),
    provider: text('provider').notNull(),
    sessionId: text('session_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex('cli_sessions_agent_conversation_unique').on(table.agentId, table.conversationKey),
  ],
);

export type CliSessionRow = typeof cliSessions.$inferSelect;
export type CliSessionInsert = typeof cliSessions.$inferInsert;
