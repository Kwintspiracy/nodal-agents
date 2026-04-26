// Connector — API key / OAuth token holder per entity per provider, matches connectors table

import { z } from 'zod';
import { ConnectorAuthTypeSchema } from '../enums.js';

export const ConnectorSchema = z
  .object({
    id: z.string().uuid(),
    entity_id: z.string().uuid().nullable(),
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
    oauth_client_id: z.string().nullable(),
    oauth_client_secret: z.string().nullable(),
    oauth_refresh_token: z.string().nullable(),
    oauth_access_token: z.string().nullable(),
    oauth_token_expires_at: z.string().datetime().nullable(),
    oauth_token_url: z.string().nullable(),
    oauth_scopes: z.string().nullable(),
    oauth_account_name: z.string().nullable(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .strict();

export const ConnectorInsertSchema = ConnectorSchema.omit({
  id: true,
  created_at: true,
  updated_at: true,
  oauth_account_name: true,
}).extend({
  active: z.boolean().default(true),
  auth_type: ConnectorAuthTypeSchema.default('api_key'),
  base_url: z.string().nullable().optional(),
  api_key: z.string().nullable().optional(),
  oauth_client_id: z.string().nullable().optional(),
  oauth_client_secret: z.string().nullable().optional(),
  oauth_refresh_token: z.string().nullable().optional(),
  oauth_access_token: z.string().nullable().optional(),
  oauth_token_expires_at: z.string().datetime().nullable().optional(),
  oauth_token_url: z.string().nullable().optional(),
  oauth_scopes: z.string().nullable().optional(),
});

export type Connector = z.infer<typeof ConnectorSchema>;
export type ConnectorInsert = z.infer<typeof ConnectorInsertSchema>;
