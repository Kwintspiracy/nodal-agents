// operations.test.ts — regression lock: APIFY_OPERATIONS slugs must match
// the tool names produced by createApifyTools(). If a tool is added/renamed
// without updating APIFY_OPERATIONS, this test fails immediately.

import { describe, it, expect } from 'vitest';
import { createApifyTools, APIFY_OPERATIONS } from '../index.ts';

describe('APIFY_OPERATIONS slugs match factory tool names', () => {
  it('slug set equals tool name set', () => {
    const tools = createApifyTools({ accessToken: 'mock-token' });
    const toolNames = tools.map((t) => t.name).sort();
    const opSlugs = APIFY_OPERATIONS.map((o) => o.slug).sort();
    expect(opSlugs).toEqual(toolNames);
  });

  it('no duplicate slugs in APIFY_OPERATIONS', () => {
    const slugs = APIFY_OPERATIONS.map((o) => o.slug);
    const unique = new Set(slugs);
    expect(unique.size).toBe(slugs.length);
  });

  it('no duplicate tool names from factory', () => {
    const tools = createApifyTools({ accessToken: 'mock-token' });
    const names = tools.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('all operations have valid risk levels', () => {
    const validRisks = new Set(['read', 'write', 'destructive']);
    for (const op of APIFY_OPERATIONS) {
      expect(validRisks.has(op.risk), `Operation ${op.slug} has invalid risk: ${op.risk}`).toBe(
        true,
      );
    }
  });

  it('apify_run_actor has risk write (it consumes platform credits)', () => {
    const op = APIFY_OPERATIONS.find((o) => o.slug === 'apify_run_actor');
    expect(op).toBeDefined();
    expect(op?.risk).toBe('write');
  });

  it('read operations do not require approval', () => {
    for (const op of APIFY_OPERATIONS) {
      if (op.risk === 'read') {
        expect(
          op.requiresApproval,
          `Read operation ${op.slug} should have requiresApproval: false`,
        ).toBe(false);
      }
    }
  });
});
