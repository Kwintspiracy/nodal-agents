// entities + entity_members tables

import {
  pgTable,
  text,
  uuid,
  jsonb,
  boolean,
  timestamp,
  uniqueIndex,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.ts';

// ─── entities ─────────────────────────────────────────────────────────────────

export const entities = pgTable(
  'entities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // FK to our own users table (replaces auth.users)
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    description: text('description'),
    icon: text('icon').default('🏢'),
    industry: text('industry'),
    goal: text('goal'),
    // IANA timezone for this workspace (e.g. 'Europe/Paris'). Captured from the
    // user's browser at onboarding, editable in Settings. Authoritative for the
    // agent: it reads the current local time and schedules crons in THIS zone.
    // null = fall back to the server's resolved timezone (legacy / pre-capture).
    timezone: text('timezone'),
    mcpToken: uuid('mcp_token').defaultRandom(),
    // ROOT agent designation (Wave 1 — V4 ROOT agent, 2026-05-29).
    // Points at the agent that receives meta-tools. Set null when no root
    // agent is designated. FK uses a lazy callback to avoid the circular
    // import (agents.ts imports entities.ts for its own FK — a direct TS
    // import here would create a module cycle; the lazy arrow breaks it at
    // Drizzle schema resolution time while TS only sees the type via the
    // forward-reference pattern).
    rootAgentId: uuid('root_agent_id'),
    // Per-grant toggles + autonomy level for the root agent. Stored as JSONB
    // and parsed at runtime via parseRootGrants() from @nodal-agents/shared.
    // Default is an empty object — the runtime falls back to DEFAULT_ROOT_GRANTS.
    rootGrants: jsonb('root_grants')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
    lastCuratorRunAt: timestamp('last_curator_run_at', { withTimezone: true }),
    reflectionEnabled: boolean('reflection_enabled').notNull().default(false),
    // Controls whether agent-authored skills are auto-assigned to the authoring
    // agent ('auto') or queued for the entity owner to approve ('approval').
    skillAssignmentMode: text('skill_assignment_mode')
      .notNull()
      .default('approval')
      .$type<'auto' | 'approval'>(),
    // Allows the workspace OWNER to opt into Yolo (auto-approve run_command)
    // even in non-local-trust (LAN/local-auth) mode. Off by default: in
    // local-auth mode, commands always require approval unless the owner
    // explicitly opts in here.
    lanCommandYolo: boolean('lan_command_yolo').notNull().default(false),
  },
  (table) => [
    uniqueIndex('entities_mcp_token_idx').on(table.mcpToken),
    index('idx_entities_user_id').on(table.userId),
    index('idx_entities_root_agent_id').on(table.rootAgentId),
  ],
);

export type EntityRow = typeof entities.$inferSelect;
export type EntityInsert = typeof entities.$inferInsert;

// ─── entity_members ───────────────────────────────────────────────────────────

export const entityMembers = pgTable(
  'entity_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').default('owner'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_entity_members_entity_id').on(table.entityId),
    index('idx_entity_members_user_id').on(table.userId),
    index('idx_entity_members_user').on(table.userId, table.entityId),
    check(
      'entity_members_role_check',
      sql`${table.role} IN ('owner', 'admin', 'member', 'viewer')`,
    ),
  ],
);

export type EntityMemberRow = typeof entityMembers.$inferSelect;
export type EntityMemberInsert = typeof entityMembers.$inferInsert;
