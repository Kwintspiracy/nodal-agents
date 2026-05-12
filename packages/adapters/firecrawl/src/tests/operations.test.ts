// operations.test.ts — regression lock: FIRECRAWL_OPERATIONS slugs must match
// the tool names produced by createFirecrawlTools(). If a tool is added/renamed
// without updating FIRECRAWL_OPERATIONS, this test fails immediately.

import { describe, it, expect } from 'vitest';
import { createFirecrawlTools, FIRECRAWL_OPERATIONS } from '../index.ts';

describe('FIRECRAWL_OPERATIONS slugs match factory tool names', () => {
  it('slug set equals tool name set', () => {
    const tools = createFirecrawlTools({ accessToken: 'mock-token' });
    const toolNames = tools.map((t) => t.name).sort();
    const opSlugs = FIRECRAWL_OPERATIONS.map((o) => o.slug).sort();
    expect(opSlugs).toEqual(toolNames);
  });

  it('no duplicate slugs in FIRECRAWL_OPERATIONS', () => {
    const slugs = FIRECRAWL_OPERATIONS.map((o) => o.slug);
    const unique = new Set(slugs);
    expect(unique.size).toBe(slugs.length);
  });

  it('no duplicate tool names from factory', () => {
    const tools = createFirecrawlTools({ accessToken: 'mock-token' });
    const names = tools.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('all operations have valid risk levels', () => {
    const validRisks = new Set(['read', 'write', 'destructive']);
    for (const op of FIRECRAWL_OPERATIONS) {
      expect(validRisks.has(op.risk), `Operation ${op.slug} has invalid risk: ${op.risk}`).toBe(
        true,
      );
    }
  });

  it('all firecrawl operations are read-level (no destructive operations)', () => {
    for (const op of FIRECRAWL_OPERATIONS) {
      expect(op.risk, `Operation ${op.slug} should be read-level`).toBe('read');
    }
  });

  it('all operations have requiresApproval false (read-only tools need no gate)', () => {
    for (const op of FIRECRAWL_OPERATIONS) {
      expect(op.requiresApproval, `Operation ${op.slug} should have requiresApproval: false`).toBe(
        false,
      );
    }
  });

  it('createFirecrawlTools throws on empty accessToken', () => {
    expect(() => createFirecrawlTools({ accessToken: '' })).toThrow(
      'FirecrawlAdapterOptions: accessToken must be a non-empty string.',
    );
  });
});
