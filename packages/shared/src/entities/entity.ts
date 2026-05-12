// Entity (workspace) and EntityMember schemas

import { z } from 'zod';
import { EntityIndustrySchema } from '../enums';

// ─── Entity ──────────────────────────────────────────────────────────────────

export const EntitySchema = z
  .object({
    id: z.string().guid(),
    user_id: z.string().guid(),
    name: z.string().min(1).max(120),
    slug: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9-]+$/),
    description: z.string().max(500).nullable(),
    icon: z.string().max(4),
    industry: EntityIndustrySchema.nullable(),
    goal: z.string().max(1000).nullable(),
    mcp_token: z.string().guid().nullable(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .strict();

export const EntityInsertSchema = EntitySchema.omit({
  id: true,
  mcp_token: true,
  created_at: true,
  updated_at: true,
}).extend({
  description: z.string().max(500).nullable().optional(),
  icon: z.string().max(4).default('🏢'),
  industry: EntityIndustrySchema.nullable().optional(),
  goal: z.string().max(1000).nullable().optional(),
});

export type Entity = z.infer<typeof EntitySchema>;
export type EntityInsert = z.infer<typeof EntityInsertSchema>;

// ─── EntityMember ─────────────────────────────────────────────────────────────

import { EntityMemberRoleSchema } from '../enums';

export const EntityMemberSchema = z
  .object({
    id: z.string().guid(),
    entity_id: z.string().guid(),
    user_id: z.string().guid(),
    role: EntityMemberRoleSchema,
    created_at: z.string().datetime(),
  })
  .strict();

export const EntityMemberInsertSchema = EntityMemberSchema.omit({
  id: true,
  created_at: true,
}).extend({
  role: EntityMemberRoleSchema.default('owner'),
});

export type EntityMember = z.infer<typeof EntityMemberSchema>;
export type EntityMemberInsert = z.infer<typeof EntityMemberInsertSchema>;
