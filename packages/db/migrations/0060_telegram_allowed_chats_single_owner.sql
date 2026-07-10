-- Single-owner constraint for telegram_allowed_chats (F1, audit#2 remediation
-- follow-up). Concurrent first-contact claims — two chats DMing a fresh bot at
-- the same moment — could each pass the "no owner yet" check before either
-- insert commits, creating two role='owner' rows for the same agent. Every
-- owner-resolution query (resolveOwnerChatId, resolveApprovalDeliveryTarget)
-- does LIMIT 1 assuming uniqueness, so a co-owner silently loses visibility
-- into approval cards routed to "the" owner.
--
-- Pre-dedup (migration 0007/0054 pattern): a bare CREATE UNIQUE INDEX
-- validates existing rows and aborts (23505) if any agent already carries
-- duplicate owners — bricking `up` with no recovery. Demote every owner row
-- but the OLDEST (created_at, id as always-unique tiebreaker) to 'member'
-- first; status is left as-is (an already-active co-owner keeps working, just
-- without owner authority). No-op on a clean install (no duplicate owners).
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY agent_id
           ORDER BY COALESCE(created_at, 'epoch'::timestamptz) ASC, id ASC
         ) AS rn
  FROM telegram_allowed_chats
  WHERE role = 'owner'
)
UPDATE telegram_allowed_chats
SET role = 'member'
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_allowed_chats_single_owner" ON "telegram_allowed_chats" USING btree ("agent_id") WHERE role = 'owner';
