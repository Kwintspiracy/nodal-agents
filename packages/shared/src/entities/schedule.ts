// AgentSchedule — cron/heartbeat automation entries, matches agent_schedules table

import { z } from 'zod';
import { ScheduleTypeSchema, ScheduleLastStatusSchema } from '../enums';

export const AgentScheduleSchema = z
  .object({
    id: z.string().guid(),
    entity_id: z.string().guid().nullable(),
    agent_id: z.string().guid(),
    type: ScheduleTypeSchema,
    name: z.string().min(1).max(120),
    cron_expr: z.string().min(1),
    task: z.string().nullable(),
    objectives: z.string().nullable(),
    active: z.boolean(),
    last_run: z.string().datetime().nullable(),
    next_run: z.string().datetime().nullable(),
    last_status: ScheduleLastStatusSchema.nullable(),
    chat_id: z.string().nullable(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .strict();

export const AgentScheduleInsertSchema = AgentScheduleSchema.omit({
  id: true,
  created_at: true,
  updated_at: true,
  last_run: true,
  next_run: true,
  last_status: true,
}).extend({
  type: ScheduleTypeSchema.default('cron'),
  active: z.boolean().default(true),
  task: z.string().nullable().optional(),
  objectives: z.string().nullable().optional(),
  chat_id: z.string().nullable().optional(),
});

export type AgentSchedule = z.infer<typeof AgentScheduleSchema>;
export type AgentScheduleInsert = z.infer<typeof AgentScheduleInsertSchema>;
