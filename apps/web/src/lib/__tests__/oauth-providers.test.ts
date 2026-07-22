// oauth-providers.test.ts — unit tests for the OAuth provider registry
// Asserts: all 6 providers present, correct attributes per provider,
// valid URLs, unknown slug returns null, getProviderByCredentialType works.

import { describe, it, expect } from 'vitest';
import {
  OAUTH_PROVIDERS,
  getOAuthProvider,
  getProviderByCredentialType,
} from '../oauth-providers.ts';

const GOOGLE_SLUGS = [
  'google-drive',
  'gmail',
  'google-calendar',
  'google-sheets',
  'google-docs',
] as const;
const ALL_SLUGS = [...GOOGLE_SLUGS, 'notion-oauth', 'airtable-oauth', 'outlook-mail'] as const;

describe('OAUTH_PROVIDERS — registry completeness', () => {
  it('contains exactly 8 providers', () => {
    expect(Object.keys(OAUTH_PROVIDERS)).toHaveLength(8);
  });

  it.each(ALL_SLUGS)('has an entry for %s', (slug) => {
    expect(OAUTH_PROVIDERS[slug]).toBeDefined();
  });
});

describe('getOAuthProvider', () => {
  it.each(ALL_SLUGS)('returns the provider for slug %s', (slug) => {
    const p = getOAuthProvider(slug);
    expect(p).not.toBeNull();
    expect(p?.slug).toBe(slug);
  });

  it('returns null for unknown slug', () => {
    expect(getOAuthProvider('unknown-provider')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(getOAuthProvider('')).toBeNull();
  });
});

describe('Google providers — shared attributes', () => {
  it.each(GOOGLE_SLUGS)('%s has pkce: pkce-s256', (slug) => {
    expect(getOAuthProvider(slug)?.pkce).toBe('pkce-s256');
  });

  it.each(GOOGLE_SLUGS)('%s has tokenAuth: body', (slug) => {
    expect(getOAuthProvider(slug)?.tokenAuth).toBe('body');
  });

  it.each(GOOGLE_SLUGS)('%s has tokenBodyType: form', (slug) => {
    expect(getOAuthProvider(slug)?.tokenBodyType).toBe('form');
  });

  it.each(GOOGLE_SLUGS)('%s has supportsRefresh: true', (slug) => {
    expect(getOAuthProvider(slug)?.supportsRefresh).toBe(true);
  });

  it.each(GOOGLE_SLUGS)('%s has non-empty scopes array', (slug) => {
    const p = getOAuthProvider(slug);
    expect(p?.scopes.length).toBeGreaterThan(0);
  });

  it.each(GOOGLE_SLUGS)('%s has accountInfo set (not null)', (slug) => {
    const p = getOAuthProvider(slug);
    expect(p?.accountInfo).not.toBeNull();
    expect(typeof p?.accountInfo?.url).toBe('string');
    expect(typeof p?.accountInfo?.nameField).toBe('string');
  });

  it.each(GOOGLE_SLUGS)('%s includes identity scopes (openid + email)', (slug) => {
    const scopes = getOAuthProvider(slug)?.scopes ?? [];
    expect(scopes).toContain('https://www.googleapis.com/auth/userinfo.email');
    expect(scopes).toContain('openid');
  });

  it.each(GOOGLE_SLUGS)(
    '%s authExtraParams includes access_type=offline + prompt=consent',
    (slug) => {
      const extra = getOAuthProvider(slug)?.authExtraParams ?? {};
      expect(extra['access_type']).toBe('offline');
      expect(extra['prompt']).toBe('consent');
    },
  );

  it.each(GOOGLE_SLUGS)('%s credentialType is google-oauth', (slug) => {
    expect(getOAuthProvider(slug)?.credentialType).toBe('google-oauth');
  });
});

describe('Notion OAuth provider — attributes', () => {
  it('has pkce: none', () => {
    expect(getOAuthProvider('notion-oauth')?.pkce).toBe('none');
  });

  it('has tokenAuth: basic', () => {
    expect(getOAuthProvider('notion-oauth')?.tokenAuth).toBe('basic');
  });

  it('has tokenBodyType: json', () => {
    expect(getOAuthProvider('notion-oauth')?.tokenBodyType).toBe('json');
  });

  it('has supportsRefresh: false', () => {
    expect(getOAuthProvider('notion-oauth')?.supportsRefresh).toBe(false);
  });

  it('has accountInfo null (Notion returns account info in token response)', () => {
    expect(getOAuthProvider('notion-oauth')?.accountInfo).toBeNull();
  });

  it('credentialType is notion-oauth', () => {
    expect(getOAuthProvider('notion-oauth')?.credentialType).toBe('notion-oauth');
  });
});

describe('Airtable OAuth provider — attributes', () => {
  it('has pkce: pkce-s256', () => {
    expect(getOAuthProvider('airtable-oauth')?.pkce).toBe('pkce-s256');
  });

  it('has tokenAuth: basic', () => {
    expect(getOAuthProvider('airtable-oauth')?.tokenAuth).toBe('basic');
  });

  it('has tokenBodyType: form', () => {
    expect(getOAuthProvider('airtable-oauth')?.tokenBodyType).toBe('form');
  });

  it('has supportsRefresh: true', () => {
    expect(getOAuthProvider('airtable-oauth')?.supportsRefresh).toBe(true);
  });

  it('has accountInfo with whoami endpoint', () => {
    const p = getOAuthProvider('airtable-oauth');
    expect(p?.accountInfo).not.toBeNull();
    expect(p?.accountInfo?.url).toBe('https://api.airtable.com/v0/meta/whoami');
    expect(p?.accountInfo?.nameField).toBe('email');
  });

  it('authUrl points to airtable.com', () => {
    expect(getOAuthProvider('airtable-oauth')?.authUrl).toContain('airtable.com');
  });

  it('tokenUrl points to airtable.com', () => {
    expect(getOAuthProvider('airtable-oauth')?.tokenUrl).toContain('airtable.com');
  });

  it('credentialType is airtable-oauth', () => {
    expect(getOAuthProvider('airtable-oauth')?.credentialType).toBe('airtable-oauth');
  });

  it('scopes include data.records:read and schema.bases:read', () => {
    const scopes = getOAuthProvider('airtable-oauth')?.scopes ?? [];
    expect(scopes).toContain('data.records:read');
    expect(scopes).toContain('schema.bases:read');
  });
});

describe('Microsoft OAuth provider (outlook-mail) — attributes', () => {
  it('has pkce: pkce-s256', () => {
    expect(getOAuthProvider('outlook-mail')?.pkce).toBe('pkce-s256');
  });

  it('has tokenAuth: body', () => {
    expect(getOAuthProvider('outlook-mail')?.tokenAuth).toBe('body');
  });

  it('has tokenBodyType: form', () => {
    expect(getOAuthProvider('outlook-mail')?.tokenBodyType).toBe('form');
  });

  it('has supportsRefresh: true', () => {
    expect(getOAuthProvider('outlook-mail')?.supportsRefresh).toBe(true);
  });

  it('credentialType is microsoft-oauth', () => {
    expect(getOAuthProvider('outlook-mail')?.credentialType).toBe('microsoft-oauth');
  });

  it('authUrl and tokenUrl point to login.microsoftonline.com', () => {
    const p = getOAuthProvider('outlook-mail');
    expect(p?.authUrl).toContain('login.microsoftonline.com');
    expect(p?.tokenUrl).toContain('login.microsoftonline.com');
  });

  it('scopes include offline_access', () => {
    const scopes = getOAuthProvider('outlook-mail')?.scopes ?? [];
    expect(scopes).toContain('offline_access');
  });

  it('scopes include the Microsoft Graph mail scopes', () => {
    const scopes = getOAuthProvider('outlook-mail')?.scopes ?? [];
    expect(scopes).toContain('https://graph.microsoft.com/Mail.ReadWrite');
    expect(scopes).toContain('https://graph.microsoft.com/Mail.Send');
    expect(scopes).toContain('https://graph.microsoft.com/MailboxSettings.Read');
  });

  it('has accountInfo pointing at the OIDC userinfo endpoint with email/preferred_username fallback', () => {
    const p = getOAuthProvider('outlook-mail');
    expect(p?.accountInfo).not.toBeNull();
    expect(p?.accountInfo?.url).toBe('https://graph.microsoft.com/oidc/userinfo');
    expect(p?.accountInfo?.emailField).toBe('email');
    expect(p?.accountInfo?.nameField).toBe('preferred_username');
  });

  it('accountInfo does NOT point at /v1.0/me (requires User.Read, which our scopes do not request)', () => {
    const p = getOAuthProvider('outlook-mail');
    expect(p?.accountInfo?.url).not.toContain('/v1.0/me');
  });
});

describe('URL validity', () => {
  it.each(ALL_SLUGS)('%s authUrl is a valid URL', (slug) => {
    const p = getOAuthProvider(slug);
    expect(() => new URL(p!.authUrl)).not.toThrow();
  });

  it.each(ALL_SLUGS)('%s tokenUrl is a valid URL', (slug) => {
    const p = getOAuthProvider(slug);
    expect(() => new URL(p!.tokenUrl)).not.toThrow();
  });

  it.each(GOOGLE_SLUGS)('%s accountInfo.url is a valid URL', (slug) => {
    const p = getOAuthProvider(slug);
    if (p?.accountInfo) {
      expect(() => new URL(p.accountInfo!.url)).not.toThrow();
    }
  });
});

describe('Provider slug self-consistency', () => {
  it.each(ALL_SLUGS)('%s has slug field matching key', (slug) => {
    expect(getOAuthProvider(slug)?.slug).toBe(slug);
  });

  it.each(ALL_SLUGS)('%s has non-empty label', (slug) => {
    const label = getOAuthProvider(slug)?.label;
    expect(typeof label).toBe('string');
    expect(label!.length).toBeGreaterThan(0);
  });
});

describe('getProviderByCredentialType', () => {
  it('returns a provider for google-oauth credential type', () => {
    const p = getProviderByCredentialType('google-oauth');
    expect(p).not.toBeNull();
    expect(p?.credentialType).toBe('google-oauth');
  });

  it('returns a provider for notion-oauth credential type', () => {
    const p = getProviderByCredentialType('notion-oauth');
    expect(p).not.toBeNull();
    expect(p?.credentialType).toBe('notion-oauth');
    expect(p?.slug).toBe('notion-oauth');
  });

  it('returns a provider for airtable-oauth credential type', () => {
    const p = getProviderByCredentialType('airtable-oauth');
    expect(p).not.toBeNull();
    expect(p?.credentialType).toBe('airtable-oauth');
    expect(p?.slug).toBe('airtable-oauth');
  });

  it('returns a provider for microsoft-oauth credential type', () => {
    const p = getProviderByCredentialType('microsoft-oauth');
    expect(p).not.toBeNull();
    expect(p?.credentialType).toBe('microsoft-oauth');
    expect(p?.slug).toBe('outlook-mail');
  });
});
