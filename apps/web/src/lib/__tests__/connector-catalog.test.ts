// connector-catalog.test.ts — regression tests for the connector catalog.
// Asserts: existing entries preserved, 5 new entries present (airtable-oauth,
// airtable, apify, firecrawl, tavily), authTypes correct.

import { describe, it, expect } from 'vitest';
import { CONNECTOR_CATALOG, type ConnectorAuthType } from '../connector-catalog.ts';

describe('CONNECTOR_CATALOG — notion-oauth entry', () => {
  it('has a notion-oauth entry', () => {
    const entry = CONNECTOR_CATALOG.find((c) => c.slug === 'notion-oauth');
    expect(entry).toBeDefined();
  });

  it('notion-oauth entry has authType: oauth2', () => {
    const entry = CONNECTOR_CATALOG.find((c) => c.slug === 'notion-oauth');
    expect(entry?.authType).toBe('oauth2' satisfies ConnectorAuthType);
  });

  it('notion-oauth entry has credentialType: notion-oauth', () => {
    const entry = CONNECTOR_CATALOG.find((c) => c.slug === 'notion-oauth');
    expect(entry?.credentialType).toBe('notion-oauth');
  });

  it('notion-oauth entry has a non-empty label', () => {
    const entry = CONNECTOR_CATALOG.find((c) => c.slug === 'notion-oauth');
    expect(typeof entry?.label).toBe('string');
    expect(entry!.label.length).toBeGreaterThan(0);
  });
});

describe('CONNECTOR_CATALOG — notion api_key entry (regression)', () => {
  it('still has a notion entry with authType: api_key', () => {
    const entry = CONNECTOR_CATALOG.find((c) => c.slug === 'notion');
    expect(entry).toBeDefined();
    expect(entry?.authType).toBe('api_key' satisfies ConnectorAuthType);
  });
});

describe('CONNECTOR_CATALOG — Google providers present', () => {
  it.each(['google-drive', 'gmail', 'google-sheets', 'google-docs'] as const)(
    'has %s with authType: oauth2',
    (slug) => {
      const entry = CONNECTOR_CATALOG.find((c) => c.slug === slug);
      expect(entry).toBeDefined();
      expect(entry?.authType).toBe('oauth2' satisfies ConnectorAuthType);
    },
  );

  it.each(['google-drive', 'gmail', 'google-sheets', 'google-docs'] as const)(
    'has %s with credentialType: google-oauth',
    (slug) => {
      const entry = CONNECTOR_CATALOG.find((c) => c.slug === slug);
      expect(entry?.credentialType).toBe('google-oauth');
    },
  );
});

describe('CONNECTOR_CATALOG — new entries (Brique 34 v3)', () => {
  it('has airtable-oauth entry with authType: oauth2', () => {
    const entry = CONNECTOR_CATALOG.find((c) => c.slug === 'airtable-oauth');
    expect(entry).toBeDefined();
    expect(entry?.authType).toBe('oauth2' satisfies ConnectorAuthType);
    expect(entry?.credentialType).toBe('airtable-oauth');
  });

  it('has airtable entry with authType: api_key', () => {
    const entry = CONNECTOR_CATALOG.find((c) => c.slug === 'airtable');
    expect(entry).toBeDefined();
    expect(entry?.authType).toBe('api_key' satisfies ConnectorAuthType);
    expect(entry?.credentialType).toBeUndefined();
  });

  it('has apify entry with authType: api_key', () => {
    const entry = CONNECTOR_CATALOG.find((c) => c.slug === 'apify');
    expect(entry).toBeDefined();
    expect(entry?.authType).toBe('api_key' satisfies ConnectorAuthType);
  });

  it('has firecrawl entry with authType: api_key', () => {
    const entry = CONNECTOR_CATALOG.find((c) => c.slug === 'firecrawl');
    expect(entry).toBeDefined();
    expect(entry?.authType).toBe('api_key' satisfies ConnectorAuthType);
  });

  it('has tavily entry with authType: api_key', () => {
    const entry = CONNECTOR_CATALOG.find((c) => c.slug === 'tavily');
    expect(entry).toBeDefined();
    expect(entry?.authType).toBe('api_key' satisfies ConnectorAuthType);
  });
});

describe('CONNECTOR_CATALOG — structural invariants', () => {
  it('all entries have non-empty slug, label, and authType', () => {
    for (const entry of CONNECTOR_CATALOG) {
      expect(entry.slug.length).toBeGreaterThan(0);
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.authType.length).toBeGreaterThan(0);
    }
  });

  it('no duplicate slugs', () => {
    const slugs = CONNECTOR_CATALOG.map((c) => c.slug);
    const unique = new Set(slugs);
    expect(unique.size).toBe(slugs.length);
  });

  it('has at least 11 entries (original 6 + 5 new)', () => {
    expect(CONNECTOR_CATALOG.length).toBeGreaterThanOrEqual(11);
  });

  it('all oauth2 entries have credentialType defined', () => {
    for (const entry of CONNECTOR_CATALOG) {
      if (entry.authType === 'oauth2') {
        expect(entry.credentialType).toBeDefined();
        expect(typeof entry.credentialType).toBe('string');
      }
    }
  });
});
