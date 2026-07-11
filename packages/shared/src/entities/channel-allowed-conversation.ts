// ChannelAllowedConversation — channel-neutral inbound authorization, matches
// channel_allowed_conversations table (S2, migration 0064). Generalizes
// telegram_allowed_chats (H-1) to any channel; see channel-binding.ts for the
// shared Channel enum and the paired per-(agent, channel) credential table.

import { z } from 'zod';
import { ChannelSchema } from './channel-binding';

export const CONVERSATION_KINDS = ['private', 'group', 'channel', 'thread'] as const;
export const ConversationKindSchema = z.enum(CONVERSATION_KINDS);
export type ConversationKind = z.infer<typeof ConversationKindSchema>;

export const CHANNEL_CONVERSATION_ROLES = ['owner', 'member'] as const;
export const ChannelConversationRoleSchema = z.enum(CHANNEL_CONVERSATION_ROLES);
export type ChannelConversationRole = z.infer<typeof ChannelConversationRoleSchema>;

export const CHANNEL_CONVERSATION_STATUSES = ['active', 'pending'] as const;
export const ChannelConversationStatusSchema = z.enum(CHANNEL_CONVERSATION_STATUSES);
export type ChannelConversationStatus = z.infer<typeof ChannelConversationStatusSchema>;

export const ChannelAllowedConversationSchema = z
  .object({
    id: z.string().guid(),
    entity_id: z.string().guid().nullable(),
    agent_id: z.string().guid(),
    channel: ChannelSchema,
    conversation_id: z.string(),
    kind: ConversationKindSchema,
    role: ChannelConversationRoleSchema,
    status: ChannelConversationStatusSchema,
    requester_name: z.string().nullable(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .strict();

export const ChannelAllowedConversationInsertSchema = ChannelAllowedConversationSchema.omit({
  id: true,
  created_at: true,
  updated_at: true,
}).extend({
  entity_id: z.string().guid().nullable().optional(),
  kind: ConversationKindSchema.default('private'),
  role: ChannelConversationRoleSchema.default('member'),
  status: ChannelConversationStatusSchema.default('pending'),
  requester_name: z.string().nullable().optional(),
});

export type ChannelAllowedConversation = z.infer<typeof ChannelAllowedConversationSchema>;
export type ChannelAllowedConversationInsert = z.infer<
  typeof ChannelAllowedConversationInsertSchema
>;
