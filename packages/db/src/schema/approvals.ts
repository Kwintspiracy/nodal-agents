// approval_requests + approval_rules tables

import { pgTable, text, uuid, jsonb, timestamp, index, check, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { entities } from './entities.ts';
import { agents } from './agents.ts';
import { agentJobs } from './jobs.ts';

// ─── approval_requests ────────────────────────────────────────────────────────

export const approvalRequests = pgTable(
  'approval_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id')
      .notNull()
      .references(() => agentJobs.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
    toolName: text('tool_name').notNull(),
    toolInput: jsonb('tool_input').notNull(),
    // The AI SDK tool-call id of the gated tool_use block (étape D). Lets the
    // resume path replace the EXACT awaiting marker instead of matching by
    // toolName alone (a fragility documented in the runner), and stamps the
    // replayed tool_calls row with its original id.
    toolCallId: text('tool_call_id'),
    status: text('status').default('pending'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: text('resolved_by'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).default(
      sql`now() + interval '1 hour'`,
    ),
    notes: text('notes'),
    /**
     * Stamped by the runner's resume step once the approved/rejected tool has
     * been executed (or its marker replaced). NULL = not yet executed.
     * Guards against double-execution on duplicate resume triggers.
     */
    executedAt: timestamp('executed_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_approval_requests_entity_id').on(table.entityId),
    index('idx_approval_status').on(table.status, table.requestedAt),
    index('idx_approval_requests_agent_id').on(table.agentId),
    index('idx_approval_requests_job_id').on(table.jobId),
    check(
      'approval_requests_status_check',
      sql`${table.status} IN ('pending','approved','rejected','expired')`,
    ),
  ],
);

export type ApprovalRequestRow = typeof approvalRequests.$inferSelect;
export type ApprovalRequestInsert = typeof approvalRequests.$inferInsert;

// ─── approval_rules ───────────────────────────────────────────────────────────

export const approvalRules = pgTable(
  'approval_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
    toolName: text('tool_name').notNull(),
    action: text('action').notNull(),
    conditionJson: jsonb('condition_json').default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_approval_rules_entity_id').on(table.entityId),
    check(
      'approval_rules_action_check',
      sql`${table.action} IN ('auto_approve','require_approval','block')`,
    ),
    // DB-1 (audit #2): one canonical rule per (entity, agent-or-null, tool) —
    // without this, two concurrent setAgentApprovalRuleAction calls (or any
    // direct insert) can leave two rows for the same scope with DIVERGENT
    // actions, and matchApprovalRule's `.find()` picks whichever the SELECT
    // happens to return first — a non-deterministic approval gate. agentId IS
    // NULL marks an entity-wide rule (e.g. the run_command LAN master-switch),
    // so a plain UNIQUE would treat two NULL rows as distinct and let the
    // duplicate back in; NULLS NOT DISTINCT (PG15+) closes that gap.
    unique('approval_rules_entity_agent_tool_unique')
      .on(table.entityId, table.agentId, table.toolName)
      .nullsNotDistinct(),
  ],
);

export type ApprovalRuleRow = typeof approvalRules.$inferSelect;
export type ApprovalRuleInsert = typeof approvalRules.$inferInsert;
