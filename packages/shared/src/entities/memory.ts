// AgentMemory — matches agent_memory table
// Note: embedding (vector(1536)) is excluded — it's a pgvector column not surfaced to JS callers

import { z } from 'zod';
import { MemoryCategorySchema, MemorySourceSchema, MemoryLayerSchema } from '../enums';

// importance is 1-5 per DB CHECK (dashboard schema uses 1-10 for input but DB stores 1-5)
// We follow the DB constraint here (source of truth)
const ImportanceSchema = z.number().int().min(1).max(5);

export const AgentMemorySchema = z
  .object({
    id: z.string().uuid(),
    entity_id: z.string().uuid().nullable(),
    agent_id: z.string().uuid().nullable(),
    fact: z.string().min(1),
    category: MemoryCategorySchema,
    importance: ImportanceSchema,
    source: MemorySourceSchema,
    skill_tags: z.array(z.string().max(60)),
    memory_layer: MemoryLayerSchema.nullable(),
    // temporal validity window
    valid_from: z.string().datetime().nullable(),
    valid_to: z.string().datetime().nullable(),
    fact_hash: z.string().nullable(),
    archived: z.boolean(),
    last_accessed_at: z.string().datetime().nullable(),
    access_count: z.number().int().min(0),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .strict();

export const AgentMemoryInsertSchema = AgentMemorySchema.omit({
  id: true,
  created_at: true,
  updated_at: true,
  fact_hash: true,
  archived: true,
  last_accessed_at: true,
  access_count: true,
  valid_from: true,
  valid_to: true,
}).extend({
  agent_id: z.string().uuid().nullable().optional(),
  category: MemoryCategorySchema.default('context'),
  importance: ImportanceSchema.default(3),
  source: MemorySourceSchema.default('manual'),
  skill_tags: z.array(z.string().max(60)).max(20).default([]),
  memory_layer: MemoryLayerSchema.nullable().optional(),
});

export type AgentMemory = z.infer<typeof AgentMemorySchema>;
export type AgentMemoryInsert = z.infer<typeof AgentMemoryInsertSchema>;
