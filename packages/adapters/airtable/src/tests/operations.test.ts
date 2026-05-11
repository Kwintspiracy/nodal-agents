// operations.test.ts — regression lock: AIRTABLE_OPERATIONS slugs must match
// the tool names produced by createAirtableTools(). If a tool is added/renamed
// without updating AIRTABLE_OPERATIONS, this test fails immediately.

import { describe, it, expect } from 'vitest';
import { createAirtableTools, AIRTABLE_OPERATIONS } from '../index.ts';

describe('AIRTABLE_OPERATIONS slugs match factory tool names', () => {
  it('slug set equals tool name set', () => {
    const tools = createAirtableTools({ accessToken: 'mock-token' });
    const toolNames = tools.map((t) => t.name).sort();
    const opSlugs = AIRTABLE_OPERATIONS.map((o) => o.slug).sort();
    expect(opSlugs).toEqual(toolNames);
  });

  it('no duplicate slugs in AIRTABLE_OPERATIONS', () => {
    const slugs = AIRTABLE_OPERATIONS.map((o) => o.slug);
    const unique = new Set(slugs);
    expect(unique.size).toBe(slugs.length);
  });

  it('no duplicate tool names from factory', () => {
    const tools = createAirtableTools({ accessToken: 'mock-token' });
    const names = tools.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('all operations have valid risk levels', () => {
    const validRisks = new Set(['read', 'write', 'destructive']);
    for (const op of AIRTABLE_OPERATIONS) {
      expect(validRisks.has(op.risk), `Operation ${op.slug} has invalid risk: ${op.risk}`).toBe(
        true,
      );
    }
  });

  it('destructive operations have requiresApproval true', () => {
    for (const op of AIRTABLE_OPERATIONS) {
      if (op.risk === 'destructive') {
        expect(
          op.requiresApproval,
          `Destructive operation ${op.slug} should have requiresApproval: true`,
        ).toBe(true);
      }
    }
  });
});
