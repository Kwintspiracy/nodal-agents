// ChannelBinding — per-(agent, channel) bot/gateway credential + identity,
// matches channel_bindings table (S2, migration 0064). Generalizes
// agents.telegram_bot_token/_bot_username/_offset to any channel — see
// channel-allowed-conversation.ts for the paired per-conversation
// authorization table (shares the Channel enum defined here).

import { z } from 'zod';

// channel_bindings.channel / channel_allowed_conversations.channel CHECK
// constraint — single source of truth for both S2 entity files.
export const CHANNELS = ['telegram', 'discord', 'slack', 'whatsapp'] as const;
export const ChannelSchema = z.enum(CHANNELS);
export type Channel = z.infer<typeof ChannelSchema>;

export const ChannelBotIdentitySchema = z
  .object({
    id: z.string().optional(),
    username: z.string().optional(),
    displayName: z.string().optional(),
  })
  .strict();
export type ChannelBotIdentity = z.infer<typeof ChannelBotIdentitySchema>;

export const ChannelBindingSchema = z
  .object({
    id: z.string().guid(),
    entity_id: z.string().guid().nullable(),
    agent_id: z.string().guid(),
    channel: ChannelSchema,
    // Opaque ciphertext (or plaintext JSON during the S2 back-fill — see
    // migration 0064). Encryption happens at the writer layer;
    // @nodal-agents/db never imports @nodal-agents/secrets, so this column is
    // untyped text here.
    credentials: z.string(),
    bot_identity: ChannelBotIdentitySchema.nullable(),
    cursor: z.string().nullable(),
    enabled: z.boolean(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .strict();

export const ChannelBindingInsertSchema = ChannelBindingSchema.omit({
  id: true,
  created_at: true,
  updated_at: true,
}).extend({
  entity_id: z.string().guid().nullable().optional(),
  bot_identity: ChannelBotIdentitySchema.nullable().optional(),
  cursor: z.string().nullable().optional(),
  enabled: z.boolean().default(true),
});

export type ChannelBinding = z.infer<typeof ChannelBindingSchema>;
export type ChannelBindingInsert = z.infer<typeof ChannelBindingInsertSchema>;
