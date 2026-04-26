// ToolCall — a single tool invocation within a job, matches tool_calls table

import { z } from 'zod';

export const ToolCallSchema = z
  .object({
    id: z.string().uuid(),
    entity_id: z.string().uuid().nullable(),
    job_id: z.string().uuid().nullable(),
    tool_name: z.string().min(1),
    tool_input: z.record(z.string(), z.unknown()).nullable(),
    tool_output: z.string().nullable(),
    duration_ms: z.number().int().min(0).nullable(),
    turn: z.number().int().min(0).nullable(),
    created_at: z.string().datetime(),
  })
  .strict();

export const ToolCallInsertSchema = ToolCallSchema.omit({
  id: true,
  created_at: true,
}).extend({
  tool_input: z.record(z.string(), z.unknown()).nullable().optional(),
  tool_output: z.string().nullable().optional(),
  duration_ms: z.number().int().min(0).nullable().optional(),
  turn: z.number().int().min(0).nullable().optional(),
});

export type ToolCall = z.infer<typeof ToolCallSchema>;
export type ToolCallInsert = z.infer<typeof ToolCallInsertSchema>;
