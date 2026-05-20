-- Migration 0015 — UNIQUE(agent_id, mcp_server_id) on agent_mcp_servers.
--
-- setAgentMcpServerAssignmentAction upserts the assignment row via
-- onConflictDoUpdate targeting (agent_id, mcp_server_id), but the table was
-- created (schema-only MCP skeleton) without a matching unique constraint —
-- so every assign attempt threw "no unique or exclusion constraint matching
-- the ON CONFLICT specification" and surfaced as "Failed to update MCP
-- assignment". This index backs the UPSERT and enforces one assignment row
-- per (agent, server).

-- IF NOT EXISTS: the index may already be present on installs where it was
-- created out-of-band before this migration shipped.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_mcp_servers_agent_server_unique"
  ON "agent_mcp_servers" ("agent_id","mcp_server_id");
