// EntityLlmKey — per-entity LLM provider API key configuration, matches entity_llm_keys table

import { z } from 'zod';

export const EntityLlmKeySchema = z
  .object({
    id: z.string().guid(),
    entity_id: z.string().guid(),
    provider: z.string().min(1),
    // api_key stored encrypted in DB; empty string = not yet set
    api_key: z.string(),
    base_url: z.string().nullable(),
    nickname: z.string().max(80).nullable(),
    is_active: z.boolean(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .strict();

export const EntityLlmKeyInsertSchema = EntityLlmKeySchema.omit({
  id: true,
  created_at: true,
  updated_at: true,
}).extend({
  api_key: z.string().default(''),
  base_url: z.string().nullable().optional(),
  nickname: z.string().max(80).nullable().optional(),
  is_active: z.boolean().default(true),
});

export type EntityLlmKey = z.infer<typeof EntityLlmKeySchema>;
export type EntityLlmKeyInsert = z.infer<typeof EntityLlmKeyInsertSchema>;
