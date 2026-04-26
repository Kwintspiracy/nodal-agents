// AgentRun — historical execution record (denormalized from job), matches agent_runs table

import { z } from 'zod';
import { RunKeySourceSchema } from '../enums.js';

export const AgentRunSchema = z
  .object({
    id: z.string().uuid(),
    entity_id: z.string().uuid().nullable(),
    agent_id: z.string().uuid().nullable(),
    task: z.string().min(1),
    result: z.string().nullable(),
    success: z.boolean(),
    tools_used: z.array(z.string()),
    tokens_used: z.number().int().min(0).nullable(),
    input_tokens: z.number().int().min(0).nullable(),
    output_tokens: z.number().int().min(0).nullable(),
    duration_ms: z.number().int().min(0).nullable(),
    key_source: RunKeySourceSchema.nullable(),
    created_at: z.string().datetime(),
  })
  .strict();

export const AgentRunInsertSchema = AgentRunSchema.omit({
  id: true,
  created_at: true,
}).extend({
  success: z.boolean().default(true),
  tools_used: z.array(z.string()).default([]),
  result: z.string().nullable().optional(),
  tokens_used: z.number().int().min(0).nullable().optional(),
  input_tokens: z.number().int().min(0).nullable().optional(),
  output_tokens: z.number().int().min(0).nullable().optional(),
  duration_ms: z.number().int().min(0).nullable().optional(),
  key_source: RunKeySourceSchema.nullable().optional(),
});

export type AgentRun = z.infer<typeof AgentRunSchema>;
export type AgentRunInsert = z.infer<typeof AgentRunInsertSchema>;
