// operations.test.ts — regression lock: GMAIL_OPERATIONS slugs must match
// the tool names produced by createGmailTools(). If a tool is added/renamed
// without updating GMAIL_OPERATIONS, this test fails immediately.

import { describe, it, expect } from 'vitest';
import { createGmailTools, GMAIL_OPERATIONS } from '../index.ts';

describe('GMAIL_OPERATIONS slugs match factory tool names', () => {
  it('slug set equals tool name set', () => {
    const tools = createGmailTools({ accessToken: 'mock-token' });
    const toolNames = tools.map((t) => t.name).sort();
    const opSlugs = GMAIL_OPERATIONS.map((o) => o.slug).sort();
    expect(opSlugs).toEqual(toolNames);
  });

  it('no duplicate slugs in GMAIL_OPERATIONS', () => {
    const slugs = GMAIL_OPERATIONS.map((o) => o.slug);
    const unique = new Set(slugs);
    expect(unique.size).toBe(slugs.length);
  });

  it('no duplicate tool names from factory', () => {
    const tools = createGmailTools({ accessToken: 'mock-token' });
    const names = tools.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });
});
