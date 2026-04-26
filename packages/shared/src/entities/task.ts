// AgentTask — task board items managed by planner orchestrators, matches agent_tasks table

import { z } from 'zod';
import { TaskStatusSchema, TaskPrioritySchema } from '../enums.js';

// description max 2000 chars enforced by DB CHECK
const TaskDescriptionSchema = z.string().max(2000).nullable();
// title max 200 chars enforced by DB CHECK
const TaskTitleSchema = z.string().min(1).max(200);

export const AgentTaskSchema = z
  .object({
    id: z.string().uuid(),
    entity_id: z.string().uuid(),
    orchestrator_id: z.string().uuid(),
    title: TaskTitleSchema,
    description: TaskDescriptionSchema,
    status: TaskStatusSchema,
    priority: TaskPrioritySchema,
    job_id: z.string().uuid().nullable(),
    result: z.string().nullable(),
    created_by_agent_id: z.string().uuid().nullable(),
    assigned_agent_id: z.string().uuid().nullable(),
    input_tokens: z.number().int().min(0),
    output_tokens: z.number().int().min(0),
    cost_usd: z.number().min(0),
    // Array of task UUIDs this task depends on — all must be 'done' before this runs
    depends_on: z.array(z.string().uuid()),
    context: z.record(z.string(), z.unknown()),
    root_job_id: z.string().uuid().nullable(),
    locked_at: z.string().datetime().nullable(),
    locked_by: z.string().nullable(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .strict();

export const AgentTaskInsertSchema = AgentTaskSchema.omit({
  id: true,
  created_at: true,
  updated_at: true,
  job_id: true,
  result: true,
  created_by_agent_id: true,
  assigned_agent_id: true,
  input_tokens: true,
  output_tokens: true,
  cost_usd: true,
  depends_on: true,
  context: true,
  root_job_id: true,
  locked_at: true,
  locked_by: true,
}).extend({
  status: TaskStatusSchema.default('todo'),
  priority: TaskPrioritySchema.default('medium'),
  description: TaskDescriptionSchema.optional(),
  depends_on: z.array(z.string().uuid()).default([]),
  context: z.record(z.string(), z.unknown()).default({}),
  root_job_id: z.string().uuid().nullable().optional(),
});

export type AgentTask = z.infer<typeof AgentTaskSchema>;
export type AgentTaskInsert = z.infer<typeof AgentTaskInsertSchema>;
