-- 0064_channel_bindings_and_allowed_conversations.sql
--
-- S2 (multichannel plan): generalizes the Telegram-only security model —
-- agents.telegram_bot_token/_bot_username/_offset (identity/credential) and
-- telegram_allowed_chats (H-1 inbound authorization, migration 0057/0060) —
-- to a channel-neutral data model, WITHOUT changing any behavior yet. The
-- Telegram runner keeps reading/writing the legacy columns/table exactly as
-- before; this migration only adds the neutral tables and back-fills them
-- once so the new surface has real data to test against. See
-- packages/db/src/queries/channel-identity.ts for the transitional read split
-- that keeps Telegram's behavior byte-identical while it exists.
--
-- channel_bindings: one row per (agent, channel) — the bot/gateway credential
-- + identity + resume cursor. `credentials` is opaque text: @nodal-agents/db
-- never imports @nodal-agents/secrets (architecture rule), so encryption
-- happens at the writer layer using the same `enc:v1:` convention as
-- entity_llm_keys.api_key. The back-fill below stores the Telegram bot token
-- AS-IS (plaintext JSON) because that mirrors agents.telegram_bot_token's
-- current at-rest state — encryption-at-rest for this column arrives when the
-- writer layer migrates (S3+).
CREATE TABLE "channel_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid,
	"agent_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"credentials" text NOT NULL,
	"bot_identity" jsonb,
	"cursor" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "channel_bindings_agent_channel_unique" UNIQUE("agent_id","channel"),
	CONSTRAINT "channel_bindings_channel_check" CHECK ("channel_bindings"."channel" IN ('telegram','discord','slack','whatsapp'))
);
--> statement-breakpoint
ALTER TABLE "channel_bindings" ADD CONSTRAINT "channel_bindings_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "entities"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "channel_bindings" ADD CONSTRAINT "channel_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_channel_bindings_agent" ON "channel_bindings" ("agent_id");
--> statement-breakpoint
CREATE INDEX "idx_channel_bindings_entity" ON "channel_bindings" ("entity_id");
--> statement-breakpoint

-- channel_allowed_conversations: one row per (agent, channel, conversation) —
-- the neutral form of telegram_allowed_chats. `kind` distinguishes 1:1 DMs
-- ('private') from multi-party surfaces ('group'/'channel'/'thread'), which
-- telegram_allowed_chats never needed to name explicitly (the back-fill below
-- infers it from the chat id's sign, Telegram's own convention for groups).
CREATE TABLE "channel_allowed_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid,
	"agent_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"conversation_id" text NOT NULL,
	"kind" text DEFAULT 'private' NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requester_name" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "channel_allowed_conversations_agent_channel_conversation_unique" UNIQUE("agent_id","channel","conversation_id"),
	CONSTRAINT "channel_allowed_conversations_channel_check" CHECK ("channel_allowed_conversations"."channel" IN ('telegram','discord','slack','whatsapp')),
	CONSTRAINT "channel_allowed_conversations_kind_check" CHECK ("channel_allowed_conversations"."kind" IN ('private','group','channel','thread')),
	CONSTRAINT "channel_allowed_conversations_role_check" CHECK ("channel_allowed_conversations"."role" IN ('owner','member')),
	CONSTRAINT "channel_allowed_conversations_status_check" CHECK ("channel_allowed_conversations"."status" IN ('active','pending'))
);
--> statement-breakpoint
ALTER TABLE "channel_allowed_conversations" ADD CONSTRAINT "channel_allowed_conversations_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "entities"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "channel_allowed_conversations" ADD CONSTRAINT "channel_allowed_conversations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_channel_allowed_conversations_agent" ON "channel_allowed_conversations" ("agent_id");
--> statement-breakpoint
CREATE INDEX "idx_channel_allowed_conversations_entity" ON "channel_allowed_conversations" ("entity_id");
--> statement-breakpoint

-- Mirrors telegram_allowed_chats_single_owner (migration 0060): at most one
-- active-owner-authority row per (agent, channel), scoped per channel so a
-- multichannel agent gets its OWN owner on each channel it's bound to.
CREATE UNIQUE INDEX "channel_allowed_conversations_single_owner" ON "channel_allowed_conversations" USING btree ("agent_id","channel") WHERE role = 'owner';
--> statement-breakpoint

-- ── Back-fill: agents.telegram_* → channel_bindings ──────────────────────────
-- One row per agent that has ever configured a Telegram bot. Idempotent via
-- ON CONFLICT on the (agent_id, channel) unique constraint.
INSERT INTO "channel_bindings" ("entity_id", "agent_id", "channel", "credentials", "bot_identity", "cursor", "enabled")
SELECT
  "entity_id",
  "id",
  'telegram',
  jsonb_build_object('botToken', "telegram_bot_token")::text,
  CASE WHEN "telegram_bot_username" IS NOT NULL
    THEN jsonb_build_object('username', "telegram_bot_username")
    ELSE NULL
  END,
  "telegram_offset"::text,
  true
FROM "agents"
WHERE "telegram_bot_token" IS NOT NULL
ON CONFLICT ("agent_id","channel") DO NOTHING;
--> statement-breakpoint

-- ── Back-fill: telegram_allowed_chats → channel_allowed_conversations ────────
-- 1:1 copy of every row (owner + member, active + pending). `kind` is inferred
-- from Telegram's own chat-id convention: negative ids are groups/supergroups,
-- positive ids are private chats. Idempotent via ON CONFLICT on the
-- (agent_id, channel, conversation_id) unique constraint.
INSERT INTO "channel_allowed_conversations" ("entity_id", "agent_id", "channel", "conversation_id", "kind", "role", "status", "requester_name", "created_at", "updated_at")
SELECT
  "entity_id",
  "agent_id",
  'telegram',
  "chat_id",
  CASE WHEN "chat_id" LIKE '-%' THEN 'group' ELSE 'private' END,
  "role",
  "status",
  "requester_name",
  "created_at",
  "updated_at"
FROM "telegram_allowed_chats"
ON CONFLICT ("agent_id","channel","conversation_id") DO NOTHING;
