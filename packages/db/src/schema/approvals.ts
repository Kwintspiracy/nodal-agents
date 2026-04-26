// approval_requests + approval_rules tables

import { pgTable, text, uuid, jsonb, timestamp, index, check } from 'drizzle-orm/pg-core';
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
    agentId: uuid('agent_id').references(() => agents.id),
    toolName: text('tool_name').notNull(),
    toolInput: jsonb('tool_input').notNull(),
    status: text('status').default('pending'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: text('resolved_by'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).default(
      sql`now() + interval '1 hour'`,
    ),
    notes: text('notes'),
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
  ],
);

export type ApprovalRuleRow = typeof approvalRules.$inferSelect;
export type ApprovalRuleInsert = typeof approvalRules.$inferInsert;
