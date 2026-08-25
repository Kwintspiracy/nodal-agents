// agent_workspaces — one-to-many workspaces per agent (Volet 5)
//
// Replaces the single agents.workspace_root_path column. Each row is an
// absolute filesystem path scoped to one agent, identified by a `label`
// (the first path segment the LLM prefixes, e.g. "notes/a.md").
//
// Security guarantees are unchanged: resolveAndCheckPath in workspace.ts
// applies the same realpath + boundary-check per selected workspace root.

import {
  pgTable,
  text,
  uuid,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { agents } from './agents.ts';
import { entities } from './entities.ts';

export const agentWorkspaces = pgTable(
  'agent_workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    // entityId mirrors the agent's entity — useful for ownership checks without
    // a join. Set to CASCADE so deleting an entity also sweeps its workspaces.
    entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
    // Human-readable label, also the first path segment the LLM must use when
    // the agent has more than one workspace (e.g. "notes/file.md").
    // Must be unique per agent. Max 80 chars keeps prompts readable.
    label: text('label').notNull(),
    // Absolute filesystem path — validated to be absolute at write time.
    path: text('path').notNull(),
    // UI display order; lower = appears first. Default 0.
    position: integer('position').default(0).notNull(),
    /**
     * Ticked by the owner: "what lives in here is development work."
     *
     * It marks a PERIMETER, not a project — ticking `Documents/Dev` does not
     * make `Dev` a project, its first-level children are the projects.
     *
     * This is the one thing the product does NOT try to guess (0085). Judging
     * by file extension missed real code; judging by the agent's skills only
     * worked for our own skills; judging by folder structure (`package.json`,
     * `.git`) would have swept in every cloned repo and unused template; and a
     * flag on the AGENT answered "who" when the question is "where" — the same
     * agent may write code in the morning and tidy a notes vault after lunch.
     *
     * A PATH counts as a dev folder when at least one of its rows is ticked:
     * five agents sharing `Documents/Dev` is one gesture, not five.
     */
    isDevFolder: boolean('is_dev_folder').default(false).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    // Enforce label uniqueness per agent
    uniqueIndex('agent_workspaces_agent_label_unique').on(table.agentId, table.label),
    // Fast lookup of all workspaces for an agent (execute.ts, actions.ts)
    index('idx_agent_workspaces_agent_id').on(table.agentId),
  ],
);

export type AgentWorkspaceRow = typeof agentWorkspaces.$inferSelect;
export type AgentWorkspaceInsert = typeof agentWorkspaces.$inferInsert;
