-- The state of a connection, kept by the product (connection_states).
--
-- A credential, a connector, an MCP server and a channel link had no state:
-- "connected" was the existence of a row, and a refresh the provider refused
-- left no trace but a log line. This table holds what was LEARNT about each
-- connection: written by the one place that learns it (the token refresh, a
-- connector call, the MCP connect, a channel's link), read by the dashboard,
-- the agent's context and the tool's error.
--
-- Existing connections get NO row. Nothing before this migration recorded an
-- observation, so any state written here would be assumed, not learnt. What
-- is true of an existing connection is read from its rows by the readers
-- themselves, at every read: a connector whose credential was deleted
-- (credential_id NULL) is `needs_reauth` (credential_removed), one whose
-- credential's grant lacks a right its operations need is `needs_reauth`
-- (rights_missing), one whose secret cannot be decrypted is `broken`; every
-- other is `working` with cause `not_checked` until its first use writes what
-- the provider answered. Proven by connection-states-migration.pg.test.ts.
--
-- `source_id` is text: a channel link has no row of its own and is keyed
-- `<agent id>:<channel>`. No foreign key: a row whose source was deleted is
-- never read again, since a re-created source has a new id.

CREATE TABLE IF NOT EXISTS connection_states (
  source_kind text NOT NULL,
  source_id text NOT NULL,
  state text NOT NULL,
  cause text NOT NULL,
  detail text,
  retry_after timestamptz,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_kind, source_id),
  CONSTRAINT connection_states_kind_check
    CHECK (source_kind IN ('credential','connector','mcp_server','channel')),
  CONSTRAINT connection_states_state_check
    CHECK (state IN ('working','needs_reauth','unreachable','broken'))
);
