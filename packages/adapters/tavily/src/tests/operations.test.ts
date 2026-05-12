// operations.test.ts — regression lock: TAVILY_OPERATIONS slugs must match
// the tool names produced by createTavilyTools(). If a tool is added/renamed
// without updating TAVILY_OPERATIONS, this test fails immediately.

import { describe, it, expect, vi } from 'vitest';
import { createTavilyTools, TAVILY_OPERATIONS } from '../index.ts';

// Mock @tavily/core so createTavilyTools() doesn't need a real API key
vi.mock('@tavily/core', () => ({
  tavily: vi.fn(() => ({
    search: vi.fn(),
    extract: vi.fn(),
    crawl: vi.fn(),
  })),
}));

describe('TAVILY_OPERATIONS slugs match factory tool names', () => {
  it('slug set equals tool name set', () => {
    const tools = createTavilyTools({ accessToken: 'mock-token' });
    const toolNames = tools.map((t) => t.name).sort();
    const opSlugs = TAVILY_OPERATIONS.map((o) => o.slug).sort();
    expect(opSlugs).toEqual(toolNames);
  });

  it('no duplicate slugs in TAVILY_OPERATIONS', () => {
    const slugs = TAVILY_OPERATIONS.map((o) => o.slug);
    const unique = new Set(slugs);
    expect(unique.size).toBe(slugs.length);
  });

  it('no duplicate tool names from factory', () => {
    const tools = createTavilyTools({ accessToken: 'mock-token' });
    const names = tools.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('all operations have valid risk levels', () => {
    const validRisks = new Set(['read', 'write', 'destructive']);
    for (const op of TAVILY_OPERATIONS) {
      expect(validRisks.has(op.risk), `Operation ${op.slug} has invalid risk: ${op.risk}`).toBe(
        true,
      );
    }
  });

  it('all tavily operations are read-level (no destructive ops)', () => {
    for (const op of TAVILY_OPERATIONS) {
      expect(op.risk, `Operation ${op.slug} should be read-level`).toBe('read');
    }
  });

  it('all read operations have requiresApproval false', () => {
    for (const op of TAVILY_OPERATIONS) {
      if (op.risk === 'read') {
        expect(
          op.requiresApproval,
          `Read operation ${op.slug} should have requiresApproval: false`,
        ).toBe(false);
      }
    }
  });
});
