// operations.test.ts — regression lock: DRIVE_OPERATIONS slugs must match
// the tool names produced by createDriveTools(). If a tool is added/renamed
// without updating DRIVE_OPERATIONS, this test fails immediately.

import { describe, it, expect } from 'vitest';
import { createDriveTools, DRIVE_OPERATIONS } from '../index.ts';

describe('DRIVE_OPERATIONS slugs match factory tool names', () => {
  it('slug set equals tool name set', () => {
    const tools = createDriveTools({ accessToken: 'mock-token' });
    const toolNames = tools.map((t) => t.name).sort();
    const opSlugs = DRIVE_OPERATIONS.map((o) => o.slug).sort();
    expect(opSlugs).toEqual(toolNames);
  });

  it('no duplicate slugs in DRIVE_OPERATIONS', () => {
    const slugs = DRIVE_OPERATIONS.map((o) => o.slug);
    const unique = new Set(slugs);
    expect(unique.size).toBe(slugs.length);
  });

  it('no duplicate tool names from factory', () => {
    const tools = createDriveTools({ accessToken: 'mock-token' });
    const names = tools.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });
});
