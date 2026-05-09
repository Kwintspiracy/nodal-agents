// Credential — first-class OAuth credential entity (n8n-style)
// Payload is always encrypted at rest (enc:v1:...) — never decoded at this layer.

import { z } from 'zod';

export const CREDENTIAL_TYPES = ['google-oauth', 'notion-oauth', 'airtable-oauth'] as const;
export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

export const CredentialSchema = z.object({
  id: z.string().uuid(),
  owner_user_id: z.string().uuid(),
  name: z.string().min(1),
  type: z.enum(CREDENTIAL_TYPES),
  payload: z.string(), // encrypted blob; never decoded at this layer
  created_at: z.date().nullable(),
  updated_at: z.date().nullable(),
});

export type Credential = z.infer<typeof CredentialSchema>;

// ── Decrypted payload schemas — validated at runtime after decrypt ─────────────

export const GoogleOauthPayloadSchema = z.object({
  clientId: z.string(),
  clientSecret: z.string(),
  refreshToken: z.string().nullable(),
  accessToken: z.string(),
  expiresAt: z.string().nullable(), // ISO 8601
  scopes: z.string(), // space-separated
  accountName: z.string(),
  tokenUrl: z.string().url(),
});

export const NotionOauthPayloadSchema = GoogleOauthPayloadSchema; // same shape; refreshToken null for Notion
export const AirtableOauthPayloadSchema = GoogleOauthPayloadSchema;

export type GoogleOauthPayload = z.infer<typeof GoogleOauthPayloadSchema>;
export type NotionOauthPayload = z.infer<typeof NotionOauthPayloadSchema>;
export type AirtableOauthPayload = z.infer<typeof AirtableOauthPayloadSchema>;
