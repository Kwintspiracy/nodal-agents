-- Migration 0014 — MCP server credentials.
--
-- The MCP-connector feature (2026-05-20) lets a NodalAI user connect a remote
-- MCP server (e.g. Cogni Cortex) and assign it to agents. An HTTP MCP server
-- needs an API key; mcp_servers had no column for one. These columns mirror
-- the connectors.api_key encryption pattern:
--   - api_key        encrypted (enc:v1: blob), NULL when the server needs no auth
--   - api_key_last4  plaintext last 4 chars, masked UI display only
--   - auth_scheme    how the key is injected: 'header' or 'query'
--   - auth_param_name  the literal header/query-param name (e.g. x-api-key)
-- The UNIQUE(entity_id, slug) constraint backs the create-from-catalog UPSERT.

ALTER TABLE "mcp_servers" ADD COLUMN "api_key" text;
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "api_key_last4" text;
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "auth_scheme" text;
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "auth_param_name" text;
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_auth_scheme_check"
  CHECK ("auth_scheme" IN ('header','query') OR "auth_scheme" IS NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_entity_slug_unique" ON "mcp_servers" ("entity_id","slug");
