// registry.test.ts — contract test for ADAPTER_REGISTRY
// Asserts:
//  1. Registry contains exactly the expected connector slugs.
//  2. Each entry has a non-empty operations array.
//  3. Each entry's credentialType is either a valid CredentialType or 'api_key'.
//  4. toolFactory is callable with a mock token and returns an array.

import { describe, it, expect } from 'vitest';
import { ADAPTER_REGISTRY } from '../registry.ts';
import { CREDENTIAL_TYPES } from '@nodal-agents/shared';

const EXPECTED_SLUGS = [
  'google-drive',
  'gmail',
  'google-sheets',
  'google-docs',
  'notion-oauth',
  'notion',
  'airtable-oauth',
  'airtable',
  'firecrawl',
  'apify',
  'tavily',
] as const;

const VALID_CREDENTIAL_SOURCES = [...CREDENTIAL_TYPES, 'api_key'] as const;

describe('ADAPTER_REGISTRY', () => {
  it('contains exactly the expected slugs', () => {
    const actualSlugs = Object.keys(ADAPTER_REGISTRY).sort();
    expect(actualSlugs).toEqual([...EXPECTED_SLUGS].sort());
  });

  it.each(EXPECTED_SLUGS)('entry "%s": has non-empty operations array', (slug) => {
    const entry = ADAPTER_REGISTRY[slug];
    expect(entry).toBeDefined();
    expect(Array.isArray(entry!.operations)).toBe(true);
    expect(entry!.operations.length).toBeGreaterThan(0);
  });

  it.each(EXPECTED_SLUGS)('entry "%s": credentialType is a CredentialType or "api_key"', (slug) => {
    const entry = ADAPTER_REGISTRY[slug];
    expect(VALID_CREDENTIAL_SOURCES).toContain(entry!.credentialType);
  });

  it.each(EXPECTED_SLUGS)(
    'entry "%s": toolFactory is callable and returns non-empty array',
    (slug) => {
      const entry = ADAPTER_REGISTRY[slug];
      const tools = entry!.toolFactory('mock-access-token');
      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBeGreaterThan(0);
    },
  );

  it.each(EXPECTED_SLUGS)(
    'entry "%s": every operation descriptor has slug, name, risk, requiresApproval',
    (slug) => {
      const entry = ADAPTER_REGISTRY[slug];
      for (const op of entry!.operations) {
        expect(typeof op.slug).toBe('string');
        expect(op.slug.length).toBeGreaterThan(0);
        expect(typeof op.name).toBe('string');
        expect(['read', 'write', 'destructive']).toContain(op.risk);
        expect(typeof op.requiresApproval).toBe('boolean');
      }
    },
  );
});
