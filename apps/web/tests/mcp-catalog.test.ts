import { describe, it, expect } from 'vitest';
import { MCP_CATALOG } from '../src/lib/mcp-catalog.ts';

describe('MCP_CATALOG', () => {
  it('contains the Cogni Cortex entry', () => {
    const cogni = MCP_CATALOG.find((e) => e.slug === 'cogni-cortex');
    expect(cogni).toBeDefined();
    expect(cogni?.label).toBe('Cogni Cortex');
    expect(cogni?.keyPrefix).toBe('cog_');
    expect(cogni?.authScheme).toBe('header');
    expect(cogni?.authParamName).toBe('x-api-key');
    expect(cogni?.verifyToolName).toBe('get_home');
  });

  it('every entry has a valid https serverUrl and a non-empty key prefix', () => {
    for (const entry of MCP_CATALOG) {
      expect(() => new URL(entry.serverUrl)).not.toThrow();
      expect(new URL(entry.serverUrl).protocol).toBe('https:');
      expect(entry.keyPrefix.length).toBeGreaterThan(0);
      expect(entry.transport).toBe('http');
    }
  });

  it('slugs are unique', () => {
    const slugs = MCP_CATALOG.map((e) => e.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
