// oauth-providers.test.ts — unit tests for the OAuth provider registry
// Asserts: all 5 providers present, correct attributes per provider,
// valid URLs, unknown slug returns null.

import { describe, it, expect } from 'vitest';
import { OAUTH_PROVIDERS, getOAuthProvider } from '../oauth-providers.ts';

const GOOGLE_SLUGS = ['google-drive', 'gmail', 'google-sheets', 'google-docs'] as const;
const ALL_SLUGS = [...GOOGLE_SLUGS, 'notion-oauth'] as const;

describe('OAUTH_PROVIDERS — registry completeness', () => {
  it('contains exactly 5 providers', () => {
    expect(Object.keys(OAUTH_PROVIDERS)).toHaveLength(5);
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
