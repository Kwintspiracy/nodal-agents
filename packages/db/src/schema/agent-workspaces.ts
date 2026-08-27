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
     * Ticked by the owner: "nothing written here is a project of mine."
     *
     * NOT the return of `is_dev_folder` (0085, dropped by 0086). That one asked
     * which folders to INCLUDE, so nothing showed until you ticked, a folder
     * you forgot lost real work in silence, and you still had to guess whether
     * the ticked folder WAS a project or CONTAINED projects.
     *
     * This one only ever removes, and it removes a whole subtree — so the
     * "is it a project?" question never arises. Everything shows by default,
     * which keeps the honest failure mode: visible noise you clear, rather than
     * missing work nothing tells you about. See 0087.
     *
     * The folder stays a full workspace: the agent reads and writes there as
     * before, and its LABEL is still used to resolve relative paths. Only the
     * project view ignores it — the Code tab and the injected `## Runtime`
     * block alike.
     *
     * A PATH counts as hidden when at least one of its rows is ticked: the same
     * folder attached to five agents is one gesture, not five.
     */
    hiddenFromCode: boolean('hidden_from_code').default(false).notNull(),
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
