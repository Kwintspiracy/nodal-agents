// whitelist.test.ts — computeToolWhitelist invariants (invariant 9: explicit whitelist)

import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { createToolRegistry } from '../registry';
import { computeToolWhitelist, agentBuiltinToolNames } from '../whitelist';
import { registerBuiltins, ALWAYS_ON_TOOLS } from '../builtin/index';
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

describe('computeToolWhitelist @cap:assigner-outils/moteur', () => {
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

  // What the job's other sources lend (delegation, delivery, connectors, MCP
  // servers) no longer goes through here: `oneTargetPerName` joins them and
  // refuses a name two sources lend (tool-sources.test.ts). This function
  // used to drop, in silence, a lent tool that carried a built-in's name.
  it('returns the built-ins only: the registry definitions, nothing else', () => {
    const result = computeToolWhitelist(
      {
        agentId: 'agent-builtins',
        configuredTools: ['notion_search'],
        alwaysOn: ['return_result'],
      },
      registry,
    );
    expect(result).toEqual([registry.get('notion_search'), registry.get('return_result')]);
  });
});

// ─── agentBuiltinToolNames — one rule for every role (#636) ──────────────────

describe('agentBuiltinToolNames @cap:assigner-outils/moteur', () => {
  const real = (): ToolRegistry => {
    const r = createToolRegistry();
    registerBuiltins(r);
    return r;
  };
  const topLevel = { delegated: false, routine: false, inConversation: false };
  const base = {
    requiredBuiltins: [] as string[],
    scriptsAuthorized: false,
    filesWritable: false,
    metaToolNames: [] as string[],
    job: topLevel,
  };

  it('always-on first, then the groups, then the gated builtins, without duplicates', () => {
    const names = agentBuiltinToolNames(
      {
        ...base,
        requiredBuiltins: ['xlsx_create', 'run_command', 'nodal_docs', 'xlsx_create'],
        metaToolNames: ['create_schedule'],
        scriptsAuthorized: true,
        filesWritable: true,
        job: { delegated: false, routine: true, inConversation: true },
      },
      real(),
    );
    expect(names).toEqual([
      ...ALWAYS_ON_TOOLS,
      'xlsx_create',
      'run_command',
      'create_schedule',
      'run_skill_script',
      'skill_file_write',
      'save_routine_state',
      'list_conversation_runs',
      'stop_conversation_run',
      'message_conversation_run',
    ]);
  });

  it('a group naming a builtin this build does not register adds nothing for it', () => {
    const names = agentBuiltinToolNames(
      { ...base, requiredBuiltins: ['xlsx_create', 'not_a_builtin'] },
      real(),
    );
    expect(names).toContain('xlsx_create');
    expect(names).not.toContain('not_a_builtin');
  });

  it('a delegated job loses dashboard_publish and the conversation tools, keeps its groups', () => {
    const names = agentBuiltinToolNames(
      {
        ...base,
        requiredBuiltins: ['xlsx_create'],
        job: { delegated: true, routine: false, inConversation: true },
      },
      real(),
    );
    expect(names).not.toContain('dashboard_publish');
    expect(names).not.toContain('list_conversation_runs');
    expect(names).not.toContain('message_conversation_run');
    expect(names).toContain('xlsx_create');
    expect(names).toEqual([
      ...ALWAYS_ON_TOOLS.filter((n) => n !== 'dashboard_publish'),
      'xlsx_create',
    ]);
  });
});
