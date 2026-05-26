-- Migration 0018 — relax mcp_servers.auth_scheme to allow 'bearer'.
--
-- Brique A v3 (MCP catalog enrichment): adds the 'bearer' auth scheme so
-- catalog entries for servers expecting `Authorization: Bearer <token>`
-- (Stripe, OpenAI, etc.) can be represented and connected without a
-- bespoke per-server hack. The adapter injects the literal "Bearer "
-- prefix when this scheme is selected; authParamName is ignored.

ALTER TABLE "mcp_servers" DROP CONSTRAINT IF EXISTS "mcp_servers_auth_scheme_check";
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_auth_scheme_check"
  CHECK ("auth_scheme" IN ('header','query','bearer') OR "auth_scheme" IS NULL);
