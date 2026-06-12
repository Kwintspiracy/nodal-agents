// AgentSkill and AgentSkillAssignment — matches agent_skills and agent_skill_assignments tables

import { z } from 'zod';
import { OperationRiskLevelSchema } from '../enums';

// ─── Skill provenance (learning-loop Phase A) ─────────────────────────────────

/** Who created this skill. 'agent' = written/patched by an agent autonomously. */
export type SkillCreatedBy = 'user' | 'system' | 'agent';

/** Lifecycle state of a skill. No hard-delete path — skills are archived only. */
export type SkillState = 'active' | 'stale' | 'archived';

/**
 * Returns true when the skill was created or patched by an agent autonomously
 * (createdBy === 'agent'). Used to gate agent self-patch operations.
 */
export function isAgentCurated(skill: { createdBy: SkillCreatedBy }): boolean {
  return skill.createdBy === 'agent';
}

/**
 * Returns true when the skill is user- or system-owned and must NOT be
 * silently overwritten by agent self-patch operations without explicit approval.
 */
export function isProtectedSkill(skill: { createdBy: SkillCreatedBy }): boolean {
  return skill.createdBy === 'user' || skill.createdBy === 'system';
}

// ─── Skill operation item (embedded in operations JSONB column) ────────────────

export const SkillOperationSchema = z
  .object({
    name: z.string().min(1),
    slug: z
      .string()
      .min(1)
      .regex(/^[a-z0-9-]+$/),
    risk: OperationRiskLevelSchema,
    requires_approval: z.boolean(),
  })
  .strict();

export type SkillOperation = z.infer<typeof SkillOperationSchema>;

// ─── Required config item (embedded in required_config JSONB column) ──────────

export const SkillRequiredConfigSchema = z
  .object({
    label: z.string().min(1),
    description: z.string().min(1),
    type: z.enum(['connector_slug', 'manual']),
    value: z.string().optional(),
    critical: z.boolean(),
  })
  .strict();

export type SkillRequiredConfig = z.infer<typeof SkillRequiredConfigSchema>;

// ─── AgentSkill ───────────────────────────────────────────────────────────────

export const AgentSkillSchema = z
  .object({
    id: z.string().guid(),
    entity_id: z.string().guid().nullable(),
    name: z.string().min(1).max(120),
    slug: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9-]+$/),
    content: z.string().min(1),
    active: z.boolean(),
    description: z.string().max(300).nullable(),
    default_content: z.string().nullable(),
    content_overridden: z.boolean(),
    required_config: z.array(SkillRequiredConfigSchema),
    operations: z.array(SkillOperationSchema),
    required_builtins: z.array(z.string()),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .strict();

export const AgentSkillInsertSchema = AgentSkillSchema.omit({
  id: true,
  created_at: true,
  updated_at: true,
}).extend({
  active: z.boolean().default(true),
  description: z.string().max(300).nullable().optional(),
  default_content: z.string().nullable().optional(),
  content_overridden: z.boolean().default(false),
  required_config: z.array(SkillRequiredConfigSchema).default([]),
  operations: z.array(SkillOperationSchema).default([]),
  required_builtins: z.array(z.string()).default([]),
});

export type AgentSkill = z.infer<typeof AgentSkillSchema>;
export type AgentSkillInsert = z.infer<typeof AgentSkillInsertSchema>;

// ─── AgentSkillAssignment ─────────────────────────────────────────────────────

export const AgentSkillAssignmentSchema = z
  .object({
    id: z.string().guid(),
    entity_id: z.string().guid(),
    agent_id: z.string().guid(),
    skill_id: z.string().guid(),
    approval_overrides: z.record(z.string(), z.boolean()),
    use_custom_instructions: z.boolean(),
    // NULL = all operations enabled; [] = none enabled
    enabled_operations: z.array(z.string()).nullable(),
    created_at: z.string().datetime(),
  })
  .strict();

export const AgentSkillAssignmentInsertSchema = AgentSkillAssignmentSchema.omit({
  id: true,
  created_at: true,
}).extend({
  approval_overrides: z.record(z.string(), z.boolean()).default({}),
  use_custom_instructions: z.boolean().default(false),
  enabled_operations: z.array(z.string()).nullable().optional(),
});

export type AgentSkillAssignment = z.infer<typeof AgentSkillAssignmentSchema>;
export type AgentSkillAssignmentInsert = z.infer<typeof AgentSkillAssignmentInsertSchema>;
