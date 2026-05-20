// mcp_servers, agent_mcp_servers, mcp_connections tables

import {
  pgTable,
  text,
  uuid,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { entities } from './entities.ts';
import { agents } from './agents.ts';

// ─── mcp_servers ──────────────────────────────────────────────────────────────

export const mcpServers = pgTable(
  'mcp_servers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    transport: text('transport').notNull(),
    url: text('url'),
    command: text('command'),
    args: text('args')
      .array()
      .default(sql`'{}'::text[]`),
    envVars: jsonb('env_vars').default(sql`'{}'::jsonb`),
    // Encrypted (enc:v1: blob) credential for HTTP MCP servers — same pattern
    // as connectors.api_key. NULL for servers that need no auth.
    apiKey: text('api_key'),
    // Plaintext last 4 chars of the key for masked UI display only.
    apiKeyLast4: text('api_key_last4'),
    // How the API key is injected into the HTTP request: 'header' (a request
    // header named by auth_param_name) or 'query' (a URL query param). NULL =
    // no auth.
    authScheme: text('auth_scheme'),
    // The literal header name or query param name (e.g. 'x-api-key', 'api_key').
    authParamName: text('auth_param_name'),
    active: boolean('active').default(true),
    availableTools: jsonb('available_tools'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    check('mcp_servers_transport_check', sql`${table.transport} IN ('http','stdio')`),
    check(
      'mcp_servers_auth_scheme_check',
      sql`${table.authScheme} IN ('header','query') OR ${table.authScheme} IS NULL`,
    ),
    uniqueIndex('mcp_servers_entity_slug_unique').on(table.entityId, table.slug),
  ],
);

export type McpServerRow = typeof mcpServers.$inferSelect;
export type McpServerInsert = typeof mcpServers.$inferInsert;

// ─── agent_mcp_servers ────────────────────────────────────────────────────────

export const agentMcpServers = pgTable(
  'agent_mcp_servers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    mcpServerId: uuid('mcp_server_id')
      .notNull()
      .references(() => mcpServers.id, { onDelete: 'cascade' }),
    enabledTools: jsonb('enabled_tools'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_agent_mcp_servers_agent').on(table.agentId),
    index('idx_agent_mcp_servers_entity').on(table.entityId),
  ],
);

export type AgentMcpServerRow = typeof agentMcpServers.$inferSelect;
export type AgentMcpServerInsert = typeof agentMcpServers.$inferInsert;

// ─── mcp_connections ──────────────────────────────────────────────────────────
// Added by 20260413_mcp_connections.sql

export const mcpConnections = pgTable(
  'mcp_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    active: boolean('active').notNull().default(true),
    toolConfig: jsonb('tool_config')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_mcp_connections_entity').on(table.entityId)],
);

export type McpConnectionRow = typeof mcpConnections.$inferSelect;
export type McpConnectionInsert = typeof mcpConnections.$inferInsert;
