-- Migration 0017 — drop UNIQUE(entity_id, slug) on mcp_servers.
--
-- Multi-instance brique: same rationale as 0016 for the connectors table.
-- Users should be able to register multiple instances of the same MCP server
-- type (e.g. two Cogni Cortex accounts) per entity. The runner already
-- iterates over agent_mcp_servers assignments by instance id; only this
-- top-level unique index blocked multi-instance.

DROP INDEX IF EXISTS "mcp_servers_entity_slug_unique";
