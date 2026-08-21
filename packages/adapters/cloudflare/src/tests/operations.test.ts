// Parity: CLOUDFLARE_OPERATIONS descriptors must exactly match the tool names
// produced by createCloudflareTools(). If a tool is added/renamed there, this
// test forces the descriptor list (the UI's operations grid) to follow.

import { describe, it, expect } from 'vitest';
import { createCloudflareTools, CLOUDFLARE_OPERATIONS } from '../index.ts';

describe('CLOUDFLARE_OPERATIONS ↔ createCloudflareTools parity', () => {
  it('descriptor slugs match tool names exactly', () => {
    const tools = createCloudflareTools({ accessToken: 'mock-token' });
    const toolNames = tools.map((t) => t.name).sort();
    const slugs = CLOUDFLARE_OPERATIONS.map((o) => o.slug).sort();
    expect(slugs).toEqual(toolNames);
  });

  it('deploy and delete are approval-gated by default; list is not', () => {
    const tools = createCloudflareTools({ accessToken: 'mock-token' });
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get('cloudflare_deploy')?.defaultApproval).toBe('require_approval');
    expect(byName.get('cloudflare_delete_worker')?.defaultApproval).toBe('require_approval');
    expect(byName.get('cloudflare_list_workers')?.defaultApproval).toBeUndefined();
    // Risk levels mirror the descriptors (the UI grid's source of truth).
    for (const op of CLOUDFLARE_OPERATIONS) {
      expect(byName.get(op.slug)?.riskLevel).toBe(op.risk);
    }
  });

  it('createCloudflareTools throws on empty accessToken', () => {
    expect(() => createCloudflareTools({ accessToken: '' })).toThrow(
      /accessToken must be a non-empty string/,
    );
  });
});
