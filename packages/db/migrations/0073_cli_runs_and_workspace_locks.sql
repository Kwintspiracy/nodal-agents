-- Étape B of the subscription-runtimes plan (2026-08-19): the code_task
-- builtin spawns the user's own coding CLI (claude -p / codex exec) under
-- their subscription.
--
-- cli_runs: one audit row per CLI invocation — what the per-agent daily
-- budget sums over, and what the per-source (subscription vs api) dashboard
-- counting reads. Kept SEPARATE from agent_jobs.total_cost_usd on purpose:
-- that column is re-seeded into the runner's in-memory accumulator on every
-- resume, so a tool writing there would collide with it.
--
-- workspace_locks: at most one WRITE-mode CLI run per workspace at a time,
-- via atomic conditional INSERT/UPDATE (house pattern; advisory locks are
-- unusable under the pglite test harness).
--
-- agents.cli_daily_budget_usd: per-agent daily cap in notional USD (the
-- claude CLI reports a notional cost even under subscription). 0 = no cap.

CREATE TABLE IF NOT EXISTS "cli_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "entity_id" uuid REFERENCES "entities"("id") ON DELETE CASCADE,
  "agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "job_id" uuid REFERENCES "agent_jobs"("id") ON DELETE SET NULL,
  "provider" text NOT NULL,
  "mode" text NOT NULL,
  "source" text NOT NULL DEFAULT 'subscription',
  "session_id" text,
  "cost_usd" real,
  "input_tokens" integer,
  "output_tokens" integer,
  "cached_tokens" integer,
  "duration_ms" integer,
  "cli_version" text,
  "exit_code" integer,
  "created_at" timestamptz DEFAULT now(),
  CONSTRAINT "cli_runs_provider_check" CHECK ("provider" IN ('claude', 'codex')),
  CONSTRAINT "cli_runs_mode_check" CHECK ("mode" IN ('read', 'write')),
  CONSTRAINT "cli_runs_source_check" CHECK ("source" IN ('subscription', 'api'))
);

CREATE INDEX IF NOT EXISTS "idx_cli_runs_agent_created" ON "cli_runs" ("agent_id","created_at");
CREATE INDEX IF NOT EXISTS "idx_cli_runs_entity_id" ON "cli_runs" ("entity_id");

CREATE TABLE IF NOT EXISTS "workspace_locks" (
  "workspace_path" text PRIMARY KEY,
  "job_id" uuid NOT NULL,
  "agent_id" uuid,
  "acquired_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "cli_daily_budget_usd" real NOT NULL DEFAULT 10;
