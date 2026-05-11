// operations.test.ts — regression lock: NOTION_OPERATIONS slugs must match
// the tool names produced by createNotionTools(). If a tool is added/renamed
// without updating NOTION_OPERATIONS, this test fails immediately.

import { describe, it, expect } from 'vitest';
import { createNotionTools, NOTION_OPERATIONS } from '../index.ts';

describe('NOTION_OPERATIONS slugs match factory tool names', () => {
  it('slug set equals tool name set', () => {
    const tools = createNotionTools({ accessToken: 'mock-token' });
    const toolNames = tools.map((t) => t.name).sort();
    const opSlugs = NOTION_OPERATIONS.map((o) => o.slug).sort();
    expect(opSlugs).toEqual(toolNames);
  });

  it('no duplicate slugs in NOTION_OPERATIONS', () => {
    const slugs = NOTION_OPERATIONS.map((o) => o.slug);
    const unique = new Set(slugs);
    expect(unique.size).toBe(slugs.length);
  });

  it('no duplicate tool names from factory', () => {
    const tools = createNotionTools({ accessToken: 'mock-token' });
    const names = tools.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });
});
