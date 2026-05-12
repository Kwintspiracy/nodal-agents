// registry.test.ts — ToolRegistry unit tests

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createToolRegistry } from '../registry';
import type { ToolDefinition, ToolContext } from '../types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeTool(
  name: string,
  riskLevel: 'read' | 'write' | 'destructive' = 'read',
): ToolDefinition<z.ZodObject<{ value: z.ZodString }>, string> {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: z.object({ value: z.string() }),
    riskLevel,
    execute: async (input: { value: string }, _ctx: ToolContext) => input.value,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createToolRegistry', () => {
  it('starts empty', () => {
    const reg = createToolRegistry();
    expect(reg.list()).toHaveLength(0);
  });

  it('registers a tool and retrieves it by name', () => {
    const reg = createToolRegistry();
    const tool = makeTool('do_thing');
    reg.register(tool);

    const got = reg.get('do_thing');
    expect(got).toBeDefined();
    expect(got?.name).toBe('do_thing');
  });

  it('returns undefined for unknown tool', () => {
    const reg = createToolRegistry();
    expect(reg.get('nope')).toBeUndefined();
  });

  it('lists all registered tools', () => {
    const reg = createToolRegistry();
    reg.register(makeTool('a'));
    reg.register(makeTool('b'));
    reg.register(makeTool('c'));
    expect(reg.list()).toHaveLength(3);
  });

  it('overwrites an existing tool on re-register', () => {
    const reg = createToolRegistry();
    reg.register(makeTool('alpha', 'read'));
    reg.register(makeTool('alpha', 'write')); // overwrite
    expect(reg.list()).toHaveLength(1);
    expect(reg.get('alpha')?.riskLevel).toBe('write');
  });

  describe('list() with filters', () => {
    it('filters by riskLevel', () => {
      const reg = createToolRegistry();
      reg.register(makeTool('r1', 'read'));
      reg.register(makeTool('r2', 'read'));
      reg.register(makeTool('w1', 'write'));
      reg.register(makeTool('d1', 'destructive'));

      const reads = reg.list({ riskLevels: ['read'] });
      expect(reads).toHaveLength(2);
      expect(reads.map((t) => t.name).sort()).toEqual(['r1', 'r2']);
    });

    it('filters by multiple riskLevels', () => {
      const reg = createToolRegistry();
      reg.register(makeTool('r1', 'read'));
      reg.register(makeTool('w1', 'write'));
      reg.register(makeTool('d1', 'destructive'));

      const result = reg.list({ riskLevels: ['read', 'write'] });
      expect(result).toHaveLength(2);
    });

    it('filters by names', () => {
      const reg = createToolRegistry();
      reg.register(makeTool('tool_a'));
      reg.register(makeTool('tool_b'));
      reg.register(makeTool('tool_c'));

      const result = reg.list({ names: ['tool_a', 'tool_c'] });
      expect(result).toHaveLength(2);
      expect(result.map((t) => t.name).sort()).toEqual(['tool_a', 'tool_c']);
    });

    it('returns empty list when names filter matches nothing', () => {
      const reg = createToolRegistry();
      reg.register(makeTool('tool_a'));
      expect(reg.list({ names: ['nonexistent'] })).toHaveLength(0);
    });

    it('returns all tools when filter is empty', () => {
      const reg = createToolRegistry();
      reg.register(makeTool('a'));
      reg.register(makeTool('b'));
      expect(reg.list({})).toHaveLength(2);
    });
  });

  describe('toAiSdkTools()', () => {
    it('returns all tools in AI SDK format', () => {
      const reg = createToolRegistry();
      reg.register(makeTool('tool_x'));
      reg.register(makeTool('tool_y'));

      const sdk = reg.toAiSdkTools();
      expect(Object.keys(sdk)).toHaveLength(2);
      expect(sdk['tool_x']).toBeDefined();
      expect(sdk['tool_x']?.description).toBe('Tool tool_x');
      // inputSchema is the Zod schema — check it validates correctly
      const parsed = sdk['tool_x']?.inputSchema.safeParse({ value: 'hi' });
      expect(parsed?.success).toBe(true);
    });

    it('filters by names in AI SDK format', () => {
      const reg = createToolRegistry();
      reg.register(makeTool('tool_a'));
      reg.register(makeTool('tool_b'));

      const sdk = reg.toAiSdkTools({ names: ['tool_a'] });
      expect(Object.keys(sdk)).toHaveLength(1);
      expect(sdk['tool_a']).toBeDefined();
      expect(sdk['tool_b']).toBeUndefined();
    });

    it('AI SDK tools do NOT have riskLevel (not part of Vercel AI format)', () => {
      const reg = createToolRegistry();
      reg.register(makeTool('my_tool', 'destructive'));

      const sdk = reg.toAiSdkTools();
      const entry = sdk['my_tool'] as unknown as Record<string, unknown>;
      expect(entry).toBeDefined();
      expect('riskLevel' in entry).toBe(false);
    });
  });
});
