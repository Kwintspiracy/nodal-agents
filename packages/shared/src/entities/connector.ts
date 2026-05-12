// Connector — API key holder per entity per provider, matches connectors table.
// OAuth tokens are now stored in the credentials table (referenced by credential_id).

import { z } from 'zod';
import { ConnectorAuthTypeSchema } from '../enums';

export const ConnectorSchema = z
  .object({
    id: z.string().guid(),
    entity_id: z.string().guid().nullable(),
    name: z.string().min(1).max(120),
    slug: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9-]+$/),
    base_url: z.string().nullable(),
    // api_key stored encrypted in DB (pgp_sym_encrypt); raw value never returned
    api_key: z.string().nullable(),
    active: z.boolean(),
    auth_type: ConnectorAuthTypeSchema,
    // FK to credentials table — null for api_key connectors
    credential_id: z.string().guid().nullable(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .strict();

export const ConnectorInsertSchema = ConnectorSchema.omit({
  id: true,
  created_at: true,
  updated_at: true,
}).extend({
  active: z.boolean().default(true),
  auth_type: ConnectorAuthTypeSchema.default('api_key'),
  base_url: z.string().nullable().optional(),
  api_key: z.string().nullable().optional(),
  credential_id: z.string().guid().nullable().optional(),
});

export type Connector = z.infer<typeof ConnectorSchema>;
export type ConnectorInsert = z.infer<typeof ConnectorInsertSchema>;
