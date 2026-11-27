// oauth-providers.ts — data-driven OAuth provider registry.
// Each entry is keyed by catalog slug (must match connector-catalog.ts).
// No runner imports, no user-facing strings except `label`.

import type { CredentialType } from '../entities/credential.ts';
import type { GrantedScopeForm } from './scopes.ts';

export type OAuthProvider = {
  slug: string;
  label: string;
  authUrl: string;
  tokenUrl: string;
  /**
   * Every scope a start for this connector asks the provider for: the rights
   * its operations declare (`OperationDescriptor.scopes`, the one declaration)
   * plus `accountScopes`. `connector-scopes.test.ts` (runner-adapters) holds
   * the two equal, so the entry never asks for less, nor for more, than the
   * connector's operations need.
   */
  scopes: readonly string[];
  /**
   * The scopes asked for the account itself rather than for an operation:
   * identity (the callback names the credential after the account) and
   * offline access. Never part of a connector's requirements.
   */
  accountScopes: readonly string[];
  /**
   * How the provider writes the scopes it granted, when it is not how they are
   * asked (see `GrantedScopeForm`). Absent: compared exactly.
   */
  grantedScopeForm?: GrantedScopeForm;
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
    // CONNECTOR-001 (audit vague D): this IS the broadest Drive scope, and it
    // is deliberate — narrowing it would remove the connector's whole point.
    // `drive.file` only ever sees files the app itself created or the user
    // hand-picked in a Google Picker; every tool shipped here works on files
    // that already exist (list, read, export, copy, move, rename, delete,
    // share, permissions), so under `drive.file` they would all return "not
    // found" on the user's real Drive. `drive.readonly` is not narrower in
    // reach either — it still exposes every file, just without writes, and it
    // would break upload/move/delete/share.
    // What is fixed instead is DISCLOSURE: the connector UI now states the
    // reach in plain language before the Google consent screen (see
    // connector-catalog.ts / scopeDisclosure), rather than letting "connect
    // Drive" read as "the files it needs".
    scopes: ['https://www.googleapis.com/auth/drive', ...GOOGLE_IDENTITY_SCOPES],
    pkce: 'pkce-s256',
    tokenAuth: 'body',
    tokenBodyType: 'form',
    accountScopes: GOOGLE_IDENTITY_SCOPES,
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
    // The union of what the Gmail operations declare (packages/adapters/gmail
    // operations.ts, from the Gmail API reference): read, send, drafts,
    // labels, organise (modify/trash) and the permanent delete, which Google
    // grants under the full mailbox scope only. It was read + send, which left
    // thirteen of the twenty-five operations failing on every call.
    scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/gmail.labels',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://mail.google.com/',
      ...GOOGLE_IDENTITY_SCOPES,
    ],
    pkce: 'pkce-s256',
    tokenAuth: 'body',
    tokenBodyType: 'form',
    accountScopes: GOOGLE_IDENTITY_SCOPES,
    accountInfo: GOOGLE_ACCOUNT_INFO,
    supportsRefresh: true,
    authExtraParams: GOOGLE_AUTH_EXTRA,
    credentialType: 'google-oauth',
  },
  'google-calendar': {
    slug: 'google-calendar',
    label: 'Google Calendar',
    authUrl: GOOGLE_AUTH_URL,
    tokenUrl: GOOGLE_TOKEN_URL,
    // CONNECTOR-001 (audit vague D): was the blanket `auth/calendar`, which
    // also grants creating and DELETING calendars and editing their sharing
    // ACLs — none of which this connector does. Its actual API surface is
    // events.{list,get,insert,patch,delete}, calendarList.list and
    // freebusy.query, so the narrow trio below covers it exactly:
    //   - calendar.events            → every events.* call
    //   - calendar.calendarlist.readonly → calendarList.list (events alone
    //     does NOT grant it, which is why the list tool needs its own scope)
    //   - calendar.freebusy         → freebusy.query, named explicitly rather
    //     than relying on it being implied by calendar.events
    // A stolen token can no longer delete a calendar; it can still change
    // events, which is what the tools are for.
    scopes: [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
      'https://www.googleapis.com/auth/calendar.freebusy',
      ...GOOGLE_IDENTITY_SCOPES,
    ],
    pkce: 'pkce-s256',
    tokenAuth: 'body',
    tokenBodyType: 'form',
    accountScopes: GOOGLE_IDENTITY_SCOPES,
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
    // CONNECTOR-001: `spreadsheets.readonly` is the only narrower scope and it
    // would break every write tool this connector ships (values, structure,
    // format, filters). Reach is disclosed in the UI instead.
    scopes: ['https://www.googleapis.com/auth/spreadsheets', ...GOOGLE_IDENTITY_SCOPES],
    pkce: 'pkce-s256',
    tokenAuth: 'body',
    tokenBodyType: 'form',
    accountScopes: GOOGLE_IDENTITY_SCOPES,
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
    // CONNECTOR-001: `documents.readonly` would break docs_create and every
    // text/format/structure edit tool. Reach is disclosed in the UI instead.
    scopes: ['https://www.googleapis.com/auth/documents', ...GOOGLE_IDENTITY_SCOPES],
    pkce: 'pkce-s256',
    tokenAuth: 'body',
    tokenBodyType: 'form',
    accountScopes: GOOGLE_IDENTITY_SCOPES,
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
    accountScopes: [],
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
    // The rights the Airtable operations declare. `schema.bases:write` is no
    // longer asked: no operation changes a base's schema. (Airtable refuses a
    // scope the integration has not enabled, so asking for less than the
    // setup guide enables is safe; asking for more would not be.)
    scopes: ['data.records:read', 'data.records:write', 'schema.bases:read'],
    accountScopes: [],
    pkce: 'pkce-s256',
    tokenAuth: 'basic',
    tokenBodyType: 'form',
    accountInfo: { url: 'https://api.airtable.com/v0/meta/whoami', nameField: 'email' },
    supportsRefresh: true,
    authExtraParams: { response_type: 'code' },
    credentialType: 'airtable-oauth',
  },
  'outlook-mail': {
    slug: 'outlook-mail',
    label: 'Outlook Mail',
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    // The rights the Outlook operations declare: Mail.ReadWrite (read and
    // change) and Mail.Send. `MailboxSettings.Read` is no longer asked: no
    // operation reads the mailbox settings.
    scopes: [
      'offline_access',
      'openid',
      'email',
      'profile',
      'https://graph.microsoft.com/Mail.ReadWrite',
      'https://graph.microsoft.com/Mail.Send',
    ],
    accountScopes: ['offline_access', 'openid', 'email', 'profile'],
    // Microsoft's token response writes a Graph permission with or without its
    // resource prefix ("scope=User.Read is equivalent to
    // https://graph.microsoft.com/User.Read", identity platform docs), and its
    // examples change the case between request and response.
    grantedScopeForm: { resourcePrefix: 'https://graph.microsoft.com/', caseInsensitive: true },
    pkce: 'pkce-s256',
    tokenAuth: 'body',
    tokenBodyType: 'form',
    // Graph's /v1.0/me requires the User.Read delegated permission, which our
    // scopes don't request — that would 403 on every connection. The OIDC
    // userinfo endpoint is covered by the openid/profile/email scopes we
    // already ask for. `email` is null on some personal Microsoft accounts —
    // nameField is set to `preferred_username` (always present, looks like an
    // email) so the generic `accountName = email ?? name` resolver in
    // callback/route.ts falls back to it automatically. No route.ts changes needed.
    accountInfo: {
      url: 'https://graph.microsoft.com/oidc/userinfo',
      nameField: 'preferred_username',
      emailField: 'email',
    },
    supportsRefresh: true,
    credentialType: 'microsoft-oauth',
  },
};

export function getOAuthProvider(slug: string): OAuthProvider | null {
  return OAUTH_PROVIDERS[slug] ?? null;
}

/**
 * Returns the first OAuth provider whose credentialType matches the given type.
 * Used by the token refresh only (refreshAndPersistCredential), which needs
 * the token endpoint and its encoding, identical for every entry of a type
 * (held by a test). Never used to choose scopes: an authorisation is asked
 * for a named connector (`getOAuthProvider`).
 */
export function getProviderByCredentialType(type: CredentialType): OAuthProvider | null {
  for (const provider of Object.values(OAUTH_PROVIDERS)) {
    if (provider.credentialType === type) return provider;
  }
  return null;
}
