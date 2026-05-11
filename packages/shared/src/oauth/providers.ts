// oauth-providers.ts — data-driven OAuth provider registry.
// Each entry is keyed by catalog slug (must match connector-catalog.ts).
// No runner imports, no user-facing strings except `label`.

import type { CredentialType } from '../entities/credential.ts';

export type OAuthProvider = {
  slug: string;
  label: string;
  authUrl: string;
  tokenUrl: string;
  scopes: readonly string[];
  /** 'pkce-s256' for Google + Airtable; 'none' for Notion */
  pkce: 'pkce-s256' | 'none';
  /** How credentials are sent to tokenUrl */
  tokenAuth: 'body' | 'basic';
  /** Body encoding for token exchange POST */
  tokenBodyType: 'form' | 'json';
  /** Endpoint to resolve display name/email after token exchange */
  accountInfo: { url: string; nameField: string; emailField?: string } | null;
  supportsRefresh: boolean;
  authExtraParams?: Record<string, string>;
  /** Maps this provider to the shared CredentialType used for the credentials table */
  credentialType: CredentialType;
};

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
/** Scopes always appended to Google providers so accountInfo fetch can identify the user. */
const GOOGLE_IDENTITY_SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
] as const;
const GOOGLE_AUTH_EXTRA: Record<string, string> = {
  access_type: 'offline',
  prompt: 'consent',
  include_granted_scopes: 'true',
};
const GOOGLE_ACCOUNT_INFO = {
  url: GOOGLE_USERINFO_URL,
  nameField: 'name',
  emailField: 'email',
} as const;

export const OAUTH_PROVIDERS: Record<string, OAuthProvider> = {
  'google-drive': {
    slug: 'google-drive',
    label: 'Google Drive',
    authUrl: GOOGLE_AUTH_URL,
    tokenUrl: GOOGLE_TOKEN_URL,
    scopes: ['https://www.googleapis.com/auth/drive', ...GOOGLE_IDENTITY_SCOPES],
    pkce: 'pkce-s256',
    tokenAuth: 'body',
    tokenBodyType: 'form',
    accountInfo: GOOGLE_ACCOUNT_INFO,
    supportsRefresh: true,
    authExtraParams: GOOGLE_AUTH_EXTRA,
    credentialType: 'google-oauth',
  },
  gmail: {
    slug: 'gmail',
    label: 'Gmail',
    authUrl: GOOGLE_AUTH_URL,
    tokenUrl: GOOGLE_TOKEN_URL,
    scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      ...GOOGLE_IDENTITY_SCOPES,
    ],
    pkce: 'pkce-s256',
    tokenAuth: 'body',
    tokenBodyType: 'form',
    accountInfo: GOOGLE_ACCOUNT_INFO,
    supportsRefresh: true,
    authExtraParams: GOOGLE_AUTH_EXTRA,
    credentialType: 'google-oauth',
  },
  'google-sheets': {
    slug: 'google-sheets',
    label: 'Google Sheets',
    authUrl: GOOGLE_AUTH_URL,
    tokenUrl: GOOGLE_TOKEN_URL,
    scopes: ['https://www.googleapis.com/auth/spreadsheets', ...GOOGLE_IDENTITY_SCOPES],
    pkce: 'pkce-s256',
    tokenAuth: 'body',
    tokenBodyType: 'form',
    accountInfo: GOOGLE_ACCOUNT_INFO,
    supportsRefresh: true,
    authExtraParams: GOOGLE_AUTH_EXTRA,
    credentialType: 'google-oauth',
  },
  'google-docs': {
    slug: 'google-docs',
    label: 'Google Docs',
    authUrl: GOOGLE_AUTH_URL,
    tokenUrl: GOOGLE_TOKEN_URL,
    scopes: ['https://www.googleapis.com/auth/documents', ...GOOGLE_IDENTITY_SCOPES],
    pkce: 'pkce-s256',
    tokenAuth: 'body',
    tokenBodyType: 'form',
    accountInfo: GOOGLE_ACCOUNT_INFO,
    supportsRefresh: true,
    authExtraParams: GOOGLE_AUTH_EXTRA,
    credentialType: 'google-oauth',
  },
  'notion-oauth': {
    slug: 'notion-oauth',
    label: 'Notion (OAuth)',
    authUrl: 'https://api.notion.com/v1/oauth/authorize',
    tokenUrl: 'https://api.notion.com/v1/oauth/token',
    // Notion does not use scope in the auth URL — capabilities are defined in the integration config.
    scopes: [],
    pkce: 'none',
    tokenAuth: 'basic',
    tokenBodyType: 'json',
    // accountInfo is null: the token response itself carries workspace_name / bot.owner.user.name.
    accountInfo: null,
    supportsRefresh: false,
    authExtraParams: {
      owner: 'user',
      response_type: 'code',
    },
    credentialType: 'notion-oauth',
  },
  'airtable-oauth': {
    slug: 'airtable-oauth',
    label: 'Airtable',
    authUrl: 'https://airtable.com/oauth2/v1/authorize',
    tokenUrl: 'https://airtable.com/oauth2/v1/token',
    scopes: ['data.records:read', 'data.records:write', 'schema.bases:read', 'schema.bases:write'],
    pkce: 'pkce-s256',
    tokenAuth: 'basic',
    tokenBodyType: 'form',
    accountInfo: { url: 'https://api.airtable.com/v0/meta/whoami', nameField: 'email' },
    supportsRefresh: true,
    authExtraParams: { response_type: 'code' },
    credentialType: 'airtable-oauth',
  },
};

export function getOAuthProvider(slug: string): OAuthProvider | null {
  return OAUTH_PROVIDERS[slug] ?? null;
}

/**
 * Returns the first OAuth provider whose credentialType matches the given type.
 * Used by refreshAndPersistCredential to resolve provider from credential row.
 */
export function getProviderByCredentialType(type: CredentialType): OAuthProvider | null {
  for (const provider of Object.values(OAUTH_PROVIDERS)) {
    if (provider.credentialType === type) return provider;
  }
  return null;
}
