// connection_states — what Nodal has learnt about each connection (migration
// 0171): an OAuth credential, a connector, an MCP server, a channel link.
//
// One row per source, written by the one place that learns its state (the
// token refresh, a connector call, the MCP connect, a channel's link) and read
// by the dashboard, the job's context and the tool's error. The vocabulary is
// `@nodal-agents/shared` connection-state.ts; the CHECKs below are its closed
// set.
//
// `source_id` is text because a channel link has no row of its own: it is
// keyed `<agent id>:<channel>` (`channelConnectionId`). The other kinds carry
// their row's uuid. No foreign key, for the same reason: a row whose source
// was deleted is never read again (a source re-created has a new id).
//
// No row means nothing has been observed since the connection was set up:
// readers return `NOT_CHECKED`, never a guess.

import { pgTable, text, timestamp, primaryKey, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const connectionStates = pgTable(
  'connection_states',
  {
    sourceKind: text('source_kind').notNull(),
    sourceId: text('source_id').notNull(),
    state: text('state').notNull(),
    cause: text('cause').notNull(),
    /** The provider's own words (OAuth error, HTTP status and message), as data. */
    detail: text('detail'),
    /** `unreachable` only: no attempt before this time. */
    retryAfter: timestamp('retry_after', { withTimezone: true }),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.sourceKind, table.sourceId] }),
    check(
      'connection_states_kind_check',
      sql`${table.sourceKind} IN ('credential','connector','mcp_server','channel')`,
    ),
    check(
      'connection_states_state_check',
      sql`${table.state} IN ('working','needs_reauth','unreachable','broken')`,
    ),
  ],
);

export type ConnectionStateRow = typeof connectionStates.$inferSelect;
