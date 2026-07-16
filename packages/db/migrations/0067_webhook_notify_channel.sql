-- Notify multi-canal pour les webhooks (B2, same plan as 0066's schedule
-- notify_channel). Webhooks never had a notify option at all — the original
-- webhooks brique scoped delivery to the HTTP caller (202 + jobId) and never
-- to the owner. Same pair of columns, same mechanic as agent_schedules.
--
-- notify_channel: explicit choice, NULL = auto (first active channel by
-- priority — no legacy telegram-only behavior to preserve here, unlike
-- schedules). Choosing a channel LINKS chatId resolution to it — see
-- routes/webhook.ts.
ALTER TABLE "webhook_triggers" ADD COLUMN "notify_on_success" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "webhook_triggers" ADD COLUMN "notify_channel" text;--> statement-breakpoint
ALTER TABLE "webhook_triggers" ADD CONSTRAINT "webhook_triggers_notify_channel_check" CHECK ("notify_channel" IN ('telegram','discord','slack','whatsapp') OR "notify_channel" IS NULL);
