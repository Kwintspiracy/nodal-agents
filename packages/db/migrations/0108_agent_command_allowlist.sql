-- Per-agent run_command allowlist.
-- NULL = no list (historical, unrestricted). Empty array = refuse everything.
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "command_allowlist" text[];
