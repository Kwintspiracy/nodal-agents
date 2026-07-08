// mcp-tool-cache.test.ts — pure decision function for the Lot A3 (lazy MCP
// connect) cache-v2 gate. No DB, no mocks: exercises the real function on
// values shaped like the `mcp_servers.available_tools` JSONB column.

import { describe, it, expect } from 'vitest';
import { isUsableMcpToolCache } from '../../job/mcp-tool-cache.ts';

describe('isUsableMcpToolCache', () => {
  it('rejects a null/undefined column (no cache written yet)', () => {
    expect(isUsableMcpToolCache(null)).toBe(false);
    expect(isUsableMcpToolCache(undefined)).toBe(false);
  });

  it('rejects an empty array', () => {
    expect(isUsableMcpToolCache([])).toBe(false);
  });

  it('rejects a non-array value', () => {
    expect(isUsableMcpToolCache({ name: 'get_home' })).toBe(false);
  });

  it('rejects a v1 cache — {name, description} only, no inputSchema', () => {
    expect(isUsableMcpToolCache([{ name: 'get_home', description: 'Home view' }])).toBe(false);
  });

  it('rejects when even one entry lacks inputSchema (mixed v1/v2)', () => {
    expect(
      isUsableMcpToolCache([
        { name: 'get_home', inputSchema: { type: 'object' } },
        { name: 'legacy_tool', description: 'no schema' },
      ]),
    ).toBe(false);
  });

  it('accepts a full v2 cache — every entry has inputSchema', () => {
    expect(
      isUsableMcpToolCache([
        {
          name: 'get_home',
          description: 'Home view',
          inputSchema: { type: 'object', properties: {} },
          annotations: { readOnlyHint: true },
        },
        { name: 'set_status', inputSchema: { type: 'object' } },
      ]),
    ).toBe(true);
  });

  it('accepts an entry with an explicit inputSchema of {} (still "defined")', () => {
    expect(isUsableMcpToolCache([{ name: 'noop', inputSchema: {} }])).toBe(true);
  });
});
