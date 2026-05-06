// whitelist.test.ts — computeToolWhitelist invariants (invariant 9: explicit whitelist)

import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { createToolRegistry } from '../registry';
import { computeToolWhitelist } from '../whitelist';
import { WhitelistDriftError } from '../errors';
import type { ToolRegistry, ToolDefinition, ToolContext } from '../types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeTool(name: string): ToolDefinition<z.ZodObject<{ x: z.ZodString }>, string> {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: z.object({ x: z.string() }),
    riskLevel: 'read',
    execute: async (_: { x: string }, _ctx: ToolContext) => 'ok',
  };
}

let registry: ToolRegistry;

beforeEach(() => {
  registry = createToolRegistry();
  registry.register(makeTool('notion_create_page'));
  registry.register(makeTool('notion_search'));
  registry.register(makeTool('return_result'));
  registry.register(makeTool('save_memory'));
  registry.register(makeTool('query_memory'));
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('computeToolWhitelist', () => {
  it('returns only the configured tools in the correct order', () => {
    const result = computeToolWhitelist(
      {
        agentId: 'agent-1',
        configuredTools: ['notion_create_page', 'notion_search'],
      },
      registry,
    );

    expect(result).toHaveLength(2);
    expect(result[0]?.name).toBe('notion_create_page');
    expect(result[1]?.name).toBe('notion_search');
  });

  it('appends alwaysOn tools and deduplicates', () => {
    const result = computeToolWhitelist(
      {
        agentId: 'agent-1',
        configuredTools: ['notion_create_page', 'return_result'],
        alwaysOn: ['return_result', 'save_memory'],
      },
      registry,
    );

    // return_result appears in both but should only be in result once
    const names = result.map((t) => t.name);
    expect(names.filter((n) => n === 'return_result')).toHaveLength(1);
    expect(names).toContain('notion_create_page');
    expect(names).toContain('save_memory');
  });

  it('returns only alwaysOn tools when configuredTools is empty', () => {
    const result = computeToolWhitelist(
      {
        agentId: 'agent-1',
        configuredTools: [],
        alwaysOn: ['return_result'],
      },
      registry,
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('return_result');
  });

  it('returns empty array when both lists are empty', () => {
    const result = computeToolWhitelist(
      {
        agentId: 'agent-1',
        configuredTools: [],
        alwaysOn: [],
      },
      registry,
    );

    expect(result).toHaveLength(0);
  });

  // Invariant 9: drift detection — throws on undeclared tool
  it('throws WhitelistDriftError when a configured tool is not in registry', () => {
    expect(() =>
      computeToolWhitelist(
        {
          agentId: 'agent-42',
          configuredTools: ['notion_create_page', 'drive_list_files'], // drive not registered
        },
        registry,
      ),
    ).toThrow(WhitelistDriftError);
  });

  it('throws WhitelistDriftError when an alwaysOn tool is not in registry', () => {
    expect(() =>
      computeToolWhitelist(
        {
          agentId: 'agent-42',
          configuredTools: [],
          alwaysOn: ['web_search'], // not registered
        },
        registry,
      ),
    ).toThrow(WhitelistDriftError);
  });

  it('WhitelistDriftError includes agent id and undeclared tools', () => {
    try {
      computeToolWhitelist(
        {
          agentId: 'agent-xyz',
          configuredTools: ['unknown_tool_a', 'unknown_tool_b'],
        },
        registry,
      );
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(WhitelistDriftError);
      const err = e as WhitelistDriftError;
      expect(err.agentId).toBe('agent-xyz');
      expect(err.undeclaredTools).toContain('unknown_tool_a');
      expect(err.undeclaredTools).toContain('unknown_tool_b');
      expect(err.code).toBe('whitelist_drift');
    }
  });

  it('returned tool definitions match those in the registry', () => {
    const result = computeToolWhitelist(
      {
        agentId: 'agent-1',
        configuredTools: ['notion_search'],
      },
      registry,
    );

    expect(result[0]).toBe(registry.get('notion_search'));
  });
});
