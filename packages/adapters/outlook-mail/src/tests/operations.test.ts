// operations.test.ts — regression lock: OUTLOOK_MAIL_OPERATIONS slugs must
// match the tool names produced by createOutlookMailTools(). If a tool is
// added/renamed without updating OUTLOOK_MAIL_OPERATIONS, this test fails
// immediately.

import { describe, it, expect } from 'vitest';
import { createOutlookMailTools, OUTLOOK_MAIL_OPERATIONS } from '../index.ts';

describe('OUTLOOK_MAIL_OPERATIONS slugs match factory tool names', () => {
  it('slug set equals tool name set', () => {
    const tools = createOutlookMailTools({ accessToken: 'mock-token' });
    const toolNames = tools.map((t) => t.name).sort();
    const opSlugs = OUTLOOK_MAIL_OPERATIONS.map((o) => o.slug).sort();
    expect(opSlugs).toEqual(toolNames);
  });

  it('no duplicate slugs in OUTLOOK_MAIL_OPERATIONS', () => {
    const slugs = OUTLOOK_MAIL_OPERATIONS.map((o) => o.slug);
    const unique = new Set(slugs);
    expect(unique.size).toBe(slugs.length);
  });

  it('no duplicate tool names from factory', () => {
    const tools = createOutlookMailTools({ accessToken: 'mock-token' });
    const names = tools.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });
});
