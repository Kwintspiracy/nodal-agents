// entities + entity_members tables

import { pgTable, text, uuid, timestamp, uniqueIndex, index, check } from 'drizzle-orm/pg-core';
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
    mcpToken: uuid('mcp_token').defaultRandom(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex('entities_mcp_token_idx').on(table.mcpToken),
    index('idx_entities_user_id').on(table.userId),
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
