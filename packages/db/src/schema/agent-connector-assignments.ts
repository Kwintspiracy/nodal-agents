// agent_connector_assignments — junction table wiring agents to connectors
// Mirror of agent_skill_assignments pattern (Brique 34bis).
// enabledOperations: null = all operations enabled; array = slug whitelist.

import { pgTable, text, uuid, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { agents } from './agents.ts';
import { connectors } from './connectors.ts';
import { entities } from './entities.ts';

export const agentConnectorAssignments = pgTable(
  'agent_connector_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    connectorId: uuid('connector_id')
      .notNull()
      .references(() => connectors.id, { onDelete: 'cascade' }),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    // null = all operations enabled (default); array = whitelist of operation slugs
    enabledOperations: text('enabled_operations').array(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_agent_connector_assignments_agent_id').on(table.agentId),
    index('idx_agent_connector_assignments_connector_id').on(table.connectorId),
    unique('agent_connector_unique').on(table.agentId, table.connectorId),
  ],
);

export type AgentConnectorAssignmentRow = typeof agentConnectorAssignments.$inferSelect;
export type AgentConnectorAssignmentInsert = typeof agentConnectorAssignments.$inferInsert;
