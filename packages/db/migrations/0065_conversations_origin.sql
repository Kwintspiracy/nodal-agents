-- 0065_conversations_origin.sql
--
-- Fix: the onboarding welcome interview creates a real `conversations` row
-- (createConversationAction, called from OnboardingFlow.tsx step 4) so the
-- chat surface works during onboarding — but that row used to be
-- indistinguishable from a normal user chat, so it kept showing up in the
-- dashboard's Chats list (with the onboarding prompt visible) after the
-- operator skipped or finished the interview.
--
-- `origin` is stamped ONCE, at conversation-creation time, never rewritten
-- retroactively on skip/finish — so both the "closed without skipping" and
-- "skipped explicitly" paths are covered. The dashboard's conversation list
-- query (listConversationsAction) filters WHERE origin = 'user'. Jobs created
-- during onboarding are NOT touched by this migration — they keep showing in
-- /jobs, only the conversation is hidden from the Chats sidebar.
ALTER TABLE "conversations" ADD COLUMN "origin" text DEFAULT 'user' NOT NULL;
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_origin_check" CHECK ("conversations"."origin" IN ('user','onboarding'));
