import { describe, it, expect } from 'vitest';
import { MCP_CATALOG } from '@nodal-agents/shared';

describe('MCP_CATALOG', () => {
  it('contains the Cogni Cortex entry', () => {
    const cogni = MCP_CATALOG.find((e) => e.slug === 'cogni-cortex');
    expect(cogni).toBeDefined();
    expect(cogni?.label).toBe('Cogni Cortex');
    expect(cogni?.keyPrefix).toEqual(['cog_']);
    expect(cogni?.authScheme).toBe('header');
    expect(cogni?.authParamName).toBe('x-api-key');
    expect(cogni?.verifyToolName).toBe('get_home');
  });

  it('contains the Stripe entry with bearer auth', () => {
    const stripe = MCP_CATALOG.find((e) => e.slug === 'stripe');
    expect(stripe).toBeDefined();
    expect(stripe?.label).toBe('Stripe');
    expect(stripe?.serverUrl).toBe('https://mcp.stripe.com');
    expect(stripe?.authScheme).toBe('bearer');
    // Stripe ships both secret (sk_…) and restricted (rk_…) keys — both valid.
    expect(stripe?.keyPrefix).toEqual(['sk_', 'rk_']);
    expect(stripe?.verifyToolName).toBe('retrieve_balance');
  });

  it('contains the Composio entry with user-supplied URL', () => {
    const composio = MCP_CATALOG.find((e) => e.slug === 'composio');
    expect(composio).toBeDefined();
    expect(composio?.serverUrl).toBeNull();
    expect(composio?.verifyToolName).toBeNull();
    expect(composio?.authScheme).toBe('header');
    expect(composio?.authParamName).toBe('x-api-key');
    // Composio has no canonical prefix — accept any key shape.
    expect(composio?.keyPrefix).toEqual([]);
  });

  it('every entry with a fixed serverUrl uses https', () => {
    for (const entry of MCP_CATALOG) {
      if (entry.serverUrl === null) continue;
      expect(() => new URL(entry.serverUrl as string)).not.toThrow();
      expect(new URL(entry.serverUrl as string).protocol).toBe('https:');
    }
  });

  it('every entry declares a known transport (http or stdio)', () => {
    for (const entry of MCP_CATALOG) {
      expect(['http', 'stdio']).toContain(entry.transport);
    }
  });

  it('contains the custom-http-mcp sentinel entry (user-supplied everything)', () => {
    const custom = MCP_CATALOG.find((e) => e.slug === 'custom-http-mcp');
    expect(custom).toBeDefined();
    expect(custom?.transport).toBe('http');
    expect(custom?.serverUrl).toBeNull();
    expect(custom?.verifyToolName).toBeNull();
  });

  it('contains the custom-stdio-mcp sentinel entry', () => {
    const stdio = MCP_CATALOG.find((e) => e.slug === 'custom-stdio-mcp');
    expect(stdio).toBeDefined();
    expect(stdio?.transport).toBe('stdio');
    expect(stdio?.serverUrl).toBeNull();
    expect(stdio?.verifyToolName).toBeNull();
  });

  it('slugs are unique', () => {
    const slugs = MCP_CATALOG.map((e) => e.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
