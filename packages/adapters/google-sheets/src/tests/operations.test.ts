// operations.test.ts — regression lock: SHEETS_OPERATIONS slugs must match
// the tool names produced by createSheetsTools(). If a tool is added/renamed
// without updating SHEETS_OPERATIONS, this test fails immediately.

import { describe, it, expect } from 'vitest';
import { createSheetsTools, SHEETS_OPERATIONS } from '../index.ts';

describe('SHEETS_OPERATIONS slugs match factory tool names', () => {
  it('slug set equals tool name set', () => {
    const tools = createSheetsTools({ accessToken: 'mock-token' });
    const toolNames = tools.map((t) => t.name).sort();
    const opSlugs = SHEETS_OPERATIONS.map((o) => o.slug).sort();
    expect(opSlugs).toEqual(toolNames);
  });

  it('no duplicate slugs in SHEETS_OPERATIONS', () => {
    const slugs = SHEETS_OPERATIONS.map((o) => o.slug);
    const unique = new Set(slugs);
    expect(unique.size).toBe(slugs.length);
  });

  it('no duplicate tool names from factory', () => {
    const tools = createSheetsTools({ accessToken: 'mock-token' });
    const names = tools.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });
});
