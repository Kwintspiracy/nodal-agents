-- 0063_agent_jobs_webhook_channel.sql
--
-- Brique 5 — inbound webhooks: a `webhook_triggers` row (dormant since its
-- table was added) now fires an agent_jobs row like cron does. Allow
-- 'webhook' as an agent_jobs.channel value — mirrors migration 0024's
-- 'dashboard' addition. Rebuild the CHECK constraint. Idempotent.
--
-- No column change: the webhook variant of JobTriggerContext ({type:'webhook',
-- webhookName, slug, triggeredAt}) is stored in the existing trigger_context
-- jsonb column added by migration 0061 — schema-flexible, no migration needed.

ALTER TABLE agent_jobs DROP CONSTRAINT IF EXISTS agent_jobs_channel_check;

ALTER TABLE agent_jobs
  ADD CONSTRAINT agent_jobs_channel_check
  CHECK (channel IN ('telegram','api','whatsapp','internal','cron','task-board','slack','discord','dashboard','webhook'));
