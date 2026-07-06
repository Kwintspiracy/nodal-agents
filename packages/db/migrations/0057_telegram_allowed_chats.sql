CREATE TABLE "telegram_allowed_chats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid,
	"agent_id" uuid NOT NULL,
	"chat_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requester_name" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "telegram_allowed_chats_agent_chat_unique" UNIQUE("agent_id","chat_id"),
	CONSTRAINT "telegram_allowed_chats_role_check" CHECK ("telegram_allowed_chats"."role" IN ('owner','member')),
	CONSTRAINT "telegram_allowed_chats_status_check" CHECK ("telegram_allowed_chats"."status" IN ('active','pending'))
);
--> statement-breakpoint
ALTER TABLE "telegram_allowed_chats" ADD CONSTRAINT "telegram_allowed_chats_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "entities"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "telegram_allowed_chats" ADD CONSTRAINT "telegram_allowed_chats_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_telegram_allowed_chats_agent" ON "telegram_allowed_chats" ("agent_id");
--> statement-breakpoint
CREATE INDEX "idx_telegram_allowed_chats_entity" ON "telegram_allowed_chats" ("entity_id");
--> statement-breakpoint
-- H-1: seed the OWNER for every bot that already has a known chat, so existing
-- installs are not locked out AND a stranger can't claim ownership of a bot the
-- real user was already using. The last chat that talked to each configured bot
-- becomes its active owner. New bots (no prior chat) claim their owner on the
-- first DM instead. NULLS-safe and idempotent (unique(agent_id,chat_id)).
INSERT INTO "telegram_allowed_chats" ("entity_id", "agent_id", "chat_id", "role", "status")
SELECT "entity_id", "id", "last_seen_chat_id_telegram", 'owner', 'active'
FROM "agents"
WHERE "last_seen_chat_id_telegram" IS NOT NULL
  AND "telegram_bot_token" IS NOT NULL
ON CONFLICT ("agent_id","chat_id") DO NOTHING;
