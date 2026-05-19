// agents table + agent_assignments + agent_budgets

import {
  pgTable,
  text,
  uuid,
  boolean,
  integer,
  bigint,
  timestamp,
  index,
  check,
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
    slug: text('slug').notNull().unique(),
    personality: text('personality').notNull(),
    model: text('model').default('claude-sonnet-4-6-20260217'),
    llmKeyId: uuid('llm_key_id').references(() => entityLlmKeys.id, { onDelete: 'set null' }),
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
    requiresApproval: text('requires_approval')
      .array()
      .default(sql`'{}'::text[]`),
    capabilities: text('capabilities')
      .array()
      .default(sql`'{}'::text[]`),
    taskContextTemplate: text('task_context_template'),
    avatarUrl: text('avatar_url'),
    systemAgent: boolean('system_agent').default(false),
    // Set to true the first time the user edits `personality` on a system agent.
    // The seeder uses this to decide whether to refresh personality from the
    // catalog on subsequent boots: false = ship the latest canonical, true =
    // preserve the user's edits. Mirrors `agent_skills.content_overridden`.
    personalityOverridden: boolean('personality_overridden').default(false).notNull(),
    maxTokensPerJob: integer('max_tokens_per_job').default(0).notNull(),
    // Cap on characters of agent_memory injected into the system prompt per job
    // (Memory Sprint 2). Pure char budget — token estimation done at call site
    // (length/4). 1500 chars ≈ ~375 tokens, similar to Hermes' 2200+1375 split.
    memoryTokenBudget: integer('memory_token_budget').default(1500).notNull(),
    // Absolute filesystem path the agent's file_* tools are scoped to. NULL =
    // file tools fail loud (`workspace_not_configured`). Per-agent so each
    // agent in an entity can have its own scope (e.g. one agent on Obsidian
    // vault, another on a code repo). Resolution at tool-call time runs
    // through realpath + boundary check (see file-ops/workspace.ts).
    workspaceRootPath: text('workspace_root_path'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_agents_entity_id').on(table.entityId),
    check('agents_role_check', sql`${table.role} IN ('agent', 'orchestrator', 'system')`),
    check(
      'agents_orchestrator_mode_check',
      sql`${table.orchestratorMode} IN ('router', 'planner') OR ${table.orchestratorMode} IS NULL`,
    ),
    check('agents_max_tokens_per_job_check', sql`${table.maxTokensPerJob} >= 0`),
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
  () => [],
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
