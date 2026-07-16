-- Notify multi-canal pour les automations (B1). Today a schedule's success
-- confirmation always resolves the OWNER'S TELEGRAM chat (resolveOwnerChatId,
-- a hardcoded 'telegram' wrapper) and lets delivery-guard/deliver-results pick
-- whichever channel wins CHANNEL_PRIORITY — an agent bound to telegram+slack
-- notifies telegram today by priority coincidence, not by design.
--
-- notify_channel: explicit choice, NULL = auto (unchanged behavior: first
-- active channel by priority). Choosing a channel LINKS chatId resolution to
-- it — see run-schedules.ts's runScheduleTick.
ALTER TABLE "agent_schedules" ADD COLUMN "notify_channel" text;--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD CONSTRAINT "agent_schedules_notify_channel_check" CHECK ("notify_channel" IN ('telegram','discord','slack','whatsapp') OR "notify_channel" IS NULL);--> statement-breakpoint

-- 'notify_unreachable' — fail-loud (invariant #4) status for when the chosen
-- channel has no owner conversation yet (never DMed the bot there): the cron
-- still fires the job (no silent fallback to another channel), just without
-- a chatId, and this status surfaces the problem in the UI instead of reading
-- as an ordinary 'failed'.
ALTER TABLE "agent_schedules" DROP CONSTRAINT IF EXISTS "agent_schedules_last_status_check";--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD CONSTRAINT "agent_schedules_last_status_check" CHECK ("last_status" IN ('success','failed','no_action','budget_exhausted','notify_unreachable') OR "last_status" IS NULL);
