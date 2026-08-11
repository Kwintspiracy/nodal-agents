// agents table + agent_assignments + agent_budgets

import {
  pgTable,
  text,
  uuid,
  boolean,
  integer,
  bigint,
  timestamp,
  jsonb,
  index,
  check,
  unique,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { entities } from './entities.ts';
import { entityLlmKeys } from './llm_keys.ts';

export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    personality: text('personality').notNull(),
    model: text('model').default('claude-sonnet-4-6-20260217'),
    // Reasoning effort for the PRIMARY model ('off'|'low'|'medium'|'high'|'max').
    // NULL = Auto (provider default — pre-feature behavior). Validated at the
    // app layer against the model's reasoningControl (model-catalog.ts).
    reasoningEffort: text('reasoning_effort'),
    llmKeyId: uuid('llm_key_id').references(() => entityLlmKeys.id, { onDelete: 'set null' }),
    // Ordered LLM-key fallback chain (Guard 2). When the primary key
    // (llmKeyId) exhausts retries / times out / hits quota mid-job, the runner
    // fails over to these in order; all-down fails loud (`all_providers_failed`).
    // Empty = no failover (default). Each link is a (keyId, model) pair so a
    // fallback runs on a CHOSEN model (empty model ⇒ that provider's catalog
    // default). FK integrity is enforced in the app layer; a deleted key is
    // skipped at resolution time.
    fallbackChain: jsonb('fallback_chain')
      // reasoningEffort (optional, per link): that link's own effort on ITS
      // model's scale; absent ⇒ inherit the agent's reasoningEffort, remapped.
      .$type<Array<{ keyId: string; model: string; reasoningEffort?: string }>>()
      .default(sql`'[]'::jsonb`),
    active: boolean('active').default(true),
    isDefault: boolean('is_default').default(false),
    role: text('role').default('agent'),
    orchestratorMode: text('orchestrator_mode'),
    telegramBotToken: text('telegram_bot_token'),
    telegramBotUsername: text('telegram_bot_username'),
    // Telegram getUpdates `offset` cursor — long-poll mode persists the
    // next-update-id here so a runner restart resumes without replay.
    telegramOffset: bigint('telegram_offset', { mode: 'number' }),
    // Last chat_id seen in an inbound DM — populated by the runner poller.
    // Used to inject the delivery target into dashboard-originated jobs.
    lastSeenChatIdTelegram: text('last_seen_chat_id_telegram'),
    capabilities: text('capabilities')
      .array()
      .default(sql`'{}'::text[]`),
    taskContextTemplate: text('task_context_template'),
    avatarUrl: text('avatar_url'),
    // The voice this agent speaks with (migration 0073). BOTH NULL = mute, and
    // that is the default on purpose: a default voice would make every existing
    // agent start talking after an upgrade, and bill the synthesis of every one
    // of their messages. Free text on both, like reasoningEffort above — the
    // voice catalogue lives in packages/speech and moves at the vendors' pace,
    // not at the migrations'. A DB CHECK keeps the pair coherent: a provider
    // without a voice would have to be resolved by guessing one at speaking
    // time, which is exactly the silent fallback invariant #4 forbids.
    voiceProvider: text('voice_provider'),
    voiceId: text('voice_id'),
    // Which of the provider's synthesis models to use (migration 0074). NULL
    // means "the provider's own default", not "none" — MiniMax ships a fast
    // line and a high-fidelity line behind the same voice, and choosing between
    // latency and timbre belongs to the agent, not to this file. Deliberately
    // outside the 0073 CHECK: a model name is optional even when a voice is set.
    voiceModel: text('voice_model'),
    systemAgent: boolean('system_agent').default(false),
    maxTokensPerJob: integer('max_tokens_per_job').default(0).notNull(),
    // Cap on characters of agent_memory injected into the system prompt per job
    // (Memory Sprint 2). Pure char budget — token estimation done at call site
    // (length/4). 1500 chars ≈ ~375 tokens, similar to Hermes' 2200+1375 split.
    memoryTokenBudget: integer('memory_token_budget').default(1500).notNull(),
    // User-controlled order on the /agents page (Brique A, migration 0019).
    // Default 0 — ties are broken by `name ASC` in the list query. Newly
    // created agents land at the front of their group by default; the user
    // can adjust via the ↑/↓ buttons in the UI.
    position: integer('position').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_agents_entity_id').on(table.entityId),
    index('idx_agents_position').on(table.position),
    check('agents_role_check', sql`${table.role} IN ('agent', 'orchestrator', 'system')`),
    check(
      'agents_orchestrator_mode_check',
      sql`${table.orchestratorMode} IN ('router', 'planner') OR ${table.orchestratorMode} IS NULL`,
    ),
    check('agents_max_tokens_per_job_check', sql`${table.maxTokensPerJob} >= 0`),
    // F-6 (audit #2): slug was UNIQUE GLOBALLY, so a 2nd workspace/entity
    // installing the same community skill's companion agent (or any agent
    // sharing a slug with another entity's agent) would crash the insert —
    // and, in multi-user mode, let one entity enumerate/squat another's
    // slugs. Scoped to (entity_id, slug): every real insert always sets
    // entityId (createAgentRepo takes it as a required param — no production
    // path leaves it NULL), but the column itself is nullable, so
    // NULLS NOT DISTINCT closes the same NULL-entity gap as DB-1/agent_plugins
    // (multiple (NULL, 'x') rows would otherwise all satisfy a plain UNIQUE).
    unique('agents_entity_slug_unique').on(table.entityId, table.slug).nullsNotDistinct(),
  ],
);

export type AgentRow = typeof agents.$inferSelect;
export type AgentInsert = typeof agents.$inferInsert;

// ─── agent_assignments ────────────────────────────────────────────────────────

export const agentAssignments = pgTable(
  'agent_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orchestratorId: uuid('orchestrator_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    subAgentId: uuid('sub_agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    instructions: text('instructions'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // F-18 (audit #2): no index beyond the PK meant updateAgentAction's
    // delete-then-insert (apps/web/src/lib/actions.ts) could race and leave the
    // same sub-agent attached twice under one orchestrator (duplicated in the
    // team-block). The unique index's leading column (orchestrator_id) also
    // serves the hot read path (team-block.ts, assign-tools.ts, detach-agent.ts
    // all look up by orchestratorId alone) — no separate index needed.
    unique('agent_assignments_orchestrator_sub_agent_unique').on(
      table.orchestratorId,
      table.subAgentId,
    ),
  ],
);

export type AgentAssignmentRow = typeof agentAssignments.$inferSelect;
export type AgentAssignmentInsert = typeof agentAssignments.$inferInsert;

// ─── agent_budgets ────────────────────────────────────────────────────────────

export const agentBudgets = pgTable(
  'agent_budgets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .unique()
      .references(() => agents.id, { onDelete: 'cascade' }),
    entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
    dailyTokenLimit: bigint('daily_token_limit', { mode: 'number' }).default(0),
    monthlyTokenLimit: bigint('monthly_token_limit', { mode: 'number' }).default(0),
    alertThresholdPct: integer('alert_threshold_pct').default(80),
    autoPause: boolean('auto_pause').default(false),
    maxJobTokens: integer('max_job_tokens').default(150000),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_agent_budgets_entity_id').on(table.entityId),
    check(
      'agent_budgets_alert_threshold_pct_check',
      sql`${table.alertThresholdPct} >= 0 AND ${table.alertThresholdPct} <= 100`,
    ),
  ],
);

export type AgentBudgetRow = typeof agentBudgets.$inferSelect;
export type AgentBudgetInsert = typeof agentBudgets.$inferInsert;
