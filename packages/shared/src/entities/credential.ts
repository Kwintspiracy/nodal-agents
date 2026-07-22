// Credential — first-class OAuth credential entity (n8n-style)
// Payload is always encrypted at rest (enc:v1:...) — never decoded at this layer.

import { z } from 'zod';

export const CREDENTIAL_TYPES = [
  'google-oauth',
  'notion-oauth',
  'airtable-oauth',
  'microsoft-oauth',
] as const;
export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

export const CredentialSchema = z.object({
  id: z.string().guid(),
  owner_user_id: z.string().guid(),
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

// Notion / Airtable / Microsoft share Google's payload shape exactly (refreshToken
// nullable, Graph delegated tokens, etc.) — no adapter-specific fields today, so
// there is only one schema to validate against. Previously each had its own
// `export const XOauthPayloadSchema = GoogleOauthPayloadSchema` alias, which knip
// flagged as duplicate exports (four export names bound to the literal same
// runtime object) and nothing outside this file ever imported them as schemas —
// only the *type* aliases below are used elsewhere. Kept as type-only aliases.

export type GoogleOauthPayload = z.infer<typeof GoogleOauthPayloadSchema>;
export type NotionOauthPayload = GoogleOauthPayload;
export type AirtableOauthPayload = GoogleOauthPayload;
export type MicrosoftOauthPayload = GoogleOauthPayload;
