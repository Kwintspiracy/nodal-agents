// operations.test.ts — regression lock: POYO_OPERATIONS slugs must match the
// tool names produced by createPoyoTools(). If a tool is added/renamed without
// updating POYO_OPERATIONS, this test fails immediately.

import { describe, it, expect } from 'vitest';
import { createPoyoTools, POYO_OPERATIONS } from '../index.ts';

describe('POYO_OPERATIONS slugs match factory tool names', () => {
  it('slug set equals tool name set', () => {
    const tools = createPoyoTools({ accessToken: 'mock-token' });
    const toolNames = tools.map((t) => t.name).sort();
    const opSlugs = POYO_OPERATIONS.map((o) => o.slug).sort();
    expect(opSlugs).toEqual(toolNames);
  });

  it('no duplicate slugs in POYO_OPERATIONS', () => {
    const slugs = POYO_OPERATIONS.map((o) => o.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('all operations have valid risk levels', () => {
    const validRisks = new Set(['read', 'write', 'destructive']);
    for (const op of POYO_OPERATIONS) {
      expect(validRisks.has(op.risk), `Operation ${op.slug} has invalid risk: ${op.risk}`).toBe(
        true,
      );
    }
  });

  it('poyo_generate_image is a write op that does not require approval', () => {
    const op = POYO_OPERATIONS.find((o) => o.slug === 'poyo_generate_image');
    expect(op).toBeDefined();
    expect(op?.risk).toBe('write');
    expect(op?.requiresApproval).toBe(false);
  });
});
