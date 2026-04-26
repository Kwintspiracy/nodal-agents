// WebhookTrigger — inbound webhook that fires an agent job, matches webhook_triggers table

import { z } from 'zod';

export const WebhookTriggerSchema = z
  .object({
    id: z.string().uuid(),
    entity_id: z.string().uuid().nullable(),
    agent_id: z.string().uuid().nullable(),
    name: z.string().min(1).max(120),
    slug: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9-]+$/),
    task_template: z.string().min(1),
    active: z.boolean(),
    secret: z.string().nullable(),
    last_triggered_at: z.string().datetime().nullable(),
    trigger_count: z.number().int().min(0),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .strict();

export const WebhookTriggerInsertSchema = WebhookTriggerSchema.omit({
  id: true,
  created_at: true,
  updated_at: true,
  secret: true,
  last_triggered_at: true,
  trigger_count: true,
}).extend({
  active: z.boolean().default(true),
});

export type WebhookTrigger = z.infer<typeof WebhookTriggerSchema>;
export type WebhookTriggerInsert = z.infer<typeof WebhookTriggerInsertSchema>;
