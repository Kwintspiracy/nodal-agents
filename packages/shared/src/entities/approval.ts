// Approval schemas — ApprovalRequest (human-gate state) and ApprovalRule (policy)
// Matches approval_requests and approval_rules tables

import { z } from 'zod';
import { ApprovalStatusSchema, ApprovalRuleActionSchema } from '../enums';

// ─── ApprovalRequest ──────────────────────────────────────────────────────────

export const ApprovalRequestSchema = z
  .object({
    id: z.string().guid(),
    entity_id: z.string().guid().nullable(),
    job_id: z.string().guid(),
    agent_id: z.string().guid().nullable(),
    tool_name: z.string().min(1),
    tool_input: z.record(z.string(), z.unknown()),
    status: ApprovalStatusSchema,
    requested_at: z.string().datetime(),
    resolved_at: z.string().datetime().nullable(),
    resolved_by: z.string().nullable(),
    // default: requested_at + 1 hour
    expires_at: z.string().datetime().nullable(),
    notes: z.string().nullable(),
  })
  .strict();

export const ApprovalRequestInsertSchema = ApprovalRequestSchema.omit({
  id: true,
  requested_at: true,
  resolved_at: true,
  resolved_by: true,
  expires_at: true,
}).extend({
  status: ApprovalStatusSchema.default('pending'),
  notes: z.string().nullable().optional(),
});

export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
export type ApprovalRequestInsert = z.infer<typeof ApprovalRequestInsertSchema>;

// ─── ApprovalRule ─────────────────────────────────────────────────────────────

export const ApprovalRuleSchema = z
  .object({
    id: z.string().guid(),
    entity_id: z.string().guid().nullable(),
    agent_id: z.string().guid().nullable(),
    tool_name: z.string().min(1),
    action: ApprovalRuleActionSchema,
    condition_json: z.record(z.string(), z.unknown()),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .strict();

export const ApprovalRuleInsertSchema = ApprovalRuleSchema.omit({
  id: true,
  created_at: true,
  updated_at: true,
}).extend({
  agent_id: z.string().guid().nullable().optional(),
  condition_json: z.record(z.string(), z.unknown()).default({}),
});

export type ApprovalRule = z.infer<typeof ApprovalRuleSchema>;
export type ApprovalRuleInsert = z.infer<typeof ApprovalRuleInsertSchema>;
