// Agent definition schema — matches agents table

import { z } from 'zod';
import { AgentRoleSchema, OrchestratorModeSchema } from '../enums.js';

export const AgentSchema = z
  .object({
    id: z.string().uuid(),
    entity_id: z.string().uuid().nullable(),
    name: z.string().min(1).max(120),
    slug: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9-]+$/),
    personality: z.string().min(1),
    model: z.string().min(1),
    active: z.boolean(),
    is_default: z.boolean(),
    role: AgentRoleSchema,
    orchestrator_mode: OrchestratorModeSchema.nullable(),
    telegram_bot_token: z.string().nullable(),
    telegram_bot_username: z.string().nullable(),
    telegram_webhook_secret: z.string().nullable(),
    telegram_webhook_url: z.string().nullable(),
    requires_approval: z.array(z.string()),
    capabilities: z.array(z.string()),
    task_context_template: z.string().nullable(),
    avatar_url: z.string().nullable(),
    system_agent: z.boolean(),
    // 0 = unlimited per DB comment
    max_tokens_per_job: z.number().int().min(0),
    enabled_builtin_tools: z.array(z.string()).nullable(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .strict();

export const AgentInsertSchema = AgentSchema.omit({
  id: true,
  created_at: true,
  updated_at: true,
  telegram_webhook_secret: true,
  telegram_webhook_url: true,
  capabilities: true,
  system_agent: true,
}).extend({
  active: z.boolean().default(true),
  is_default: z.boolean().default(false),
  role: AgentRoleSchema.default('agent'),
  orchestrator_mode: OrchestratorModeSchema.nullable().optional(),
  telegram_bot_token: z.string().nullable().optional(),
  telegram_bot_username: z.string().nullable().optional(),
  requires_approval: z.array(z.string()).default([]),
  task_context_template: z.string().nullable().optional(),
  avatar_url: z.string().nullable().optional(),
  max_tokens_per_job: z.number().int().min(0).max(500_000).default(0),
  enabled_builtin_tools: z.array(z.string()).nullable().optional(),
});

export type Agent = z.infer<typeof AgentSchema>;
export type AgentInsert = z.infer<typeof AgentInsertSchema>;
