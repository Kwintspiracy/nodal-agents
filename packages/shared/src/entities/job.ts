// AgentJob — a single job execution instance, matches agent_jobs table
// State machine: pending → processing → completed | failed
// Side states: awaiting_delegation, awaiting_approval, cancelled

import { z } from 'zod';
import { JobStatusSchema, JobChannelSchema } from '../enums';

// chain_count must never be negative (DB default 0, runner enforces non-negative increments)
const ChainCountSchema = z.number().int().min(0);

// delegation_depth must never be negative
const DelegationDepthSchema = z.number().int().min(0);

export const AgentJobSchema = z
  .object({
    id: z.string().guid(),
    entity_id: z.string().guid().nullable(),
    agent_id: z.string().guid().nullable(),
    status: JobStatusSchema,
    channel: JobChannelSchema,
    task: z.string().min(1),
    original_task: z.string().nullable(),
    chat_id: z.string().nullable(),
    system_prompt: z.string().nullable(),
    messages: z.array(z.record(z.string(), z.unknown())),
    tools_used: z.array(z.string()),
    turn: z.number().int().min(0),
    result: z.string().nullable(),
    error: z.string().nullable(),
    chain_count: ChainCountSchema,
    request_id: z.string().nullable(),
    parent_job_id: z.string().guid().nullable(),
    parent_request_id: z.string().nullable(),
    total_duration_ms: z.number().int().min(0),
    input_tokens: z.number().int().min(0),
    output_tokens: z.number().int().min(0),
    delegation_depth: DelegationDepthSchema,
    pending_delegation: z.record(z.string(), z.unknown()).nullable(),
    completed_at: z.string().datetime().nullable(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .strict();

export const AgentJobInsertSchema = AgentJobSchema.omit({
  id: true,
  created_at: true,
  updated_at: true,
  completed_at: true,
  messages: true,
  tools_used: true,
  turn: true,
  result: true,
  error: true,
  chain_count: true,
  total_duration_ms: true,
  input_tokens: true,
  output_tokens: true,
  delegation_depth: true,
  pending_delegation: true,
  parent_request_id: true,
}).extend({
  status: JobStatusSchema.default('pending'),
  original_task: z.string().nullable().optional(),
  chat_id: z.string().nullable().optional(),
  system_prompt: z.string().nullable().optional(),
  request_id: z.string().nullable().optional(),
  parent_job_id: z.string().guid().nullable().optional(),
});

export type AgentJob = z.infer<typeof AgentJobSchema>;
export type AgentJobInsert = z.infer<typeof AgentJobInsertSchema>;
