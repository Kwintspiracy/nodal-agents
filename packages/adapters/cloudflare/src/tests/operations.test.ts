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

  // The descriptor is the one source of a connector tool's risk and default
  // approval (issue #735): ADAPTER_REGISTRY applies it to the tool, and
  // runner-adapters' registry test proves it on every connector.
  it('deploy and delete are approval-gated by default; list is not', () => {
    const bySlug = new Map(CLOUDFLARE_OPERATIONS.map((o) => [o.slug, o]));
    expect(bySlug.get('cloudflare_deploy')).toMatchObject({
      risk: 'write',
      requiresApproval: true,
    });
    expect(bySlug.get('cloudflare_delete_worker')).toMatchObject({
      risk: 'destructive',
      requiresApproval: true,
    });
    expect(bySlug.get('cloudflare_list_workers')).toMatchObject({
      risk: 'read',
      requiresApproval: false,
    });
  });

  it('createCloudflareTools throws on empty accessToken', () => {
    expect(() => createCloudflareTools({ accessToken: '' })).toThrow(
      /accessToken must be a non-empty string/,
    );
  });
});
