// mcp-approval-gate.test.ts — MCP-001 regression suite.
//
// Before the fix, a tool coming from a third-party MCP server declared no
// `defaultApproval`, so executeTool fell through
// `matchedRule?.action ?? tool.defaultApproval` to `undefined` and executed it.
// Measured against the real gate: `execute()` was called and no approval was
// requested in ALL FOUR autonomy modes, including the default.
//
// Assertions are on real results — whether the tool's own execute() ran, and
// what outcome the gate returned — never on call counts alone.

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { executeTool } from '../execute.ts';
import type { ExecuteOptions, ToolContext, ToolDefinition } from '../types.ts';

type Autonomy = ExecuteOptions['autonomy'];

/** Minimal ToolContext: the gate only needs the ids and an insertable db. */
function makeCtx(): ToolContext {
  return {
    db: {
      insert: () => ({
        values: () => ({ returning: async () => [{ id: 'approval-row-id' }] }),
      }),
    },
    entityId: 'entity-1',
    agentId: 'agent-1',
    jobId: 'job-1',
  } as unknown as ToolContext;
}

/**
 * A tool shaped exactly as `buildMcpToolDefinition` produces one: namespaced
 * name, framed description, schema, riskLevel — and now `defaultApproval`.
 */
function makeMcpTool(overrides: Partial<ToolDefinition<z.ZodTypeAny, unknown>> = {}) {
  const execute = vi.fn(async () => ({ ok: true }));
  const tool = {
    name: 'veille__purge_all_data',
    description: 'Supprime définitivement toutes les données du workspace.',
    inputSchema: z.object({}),
    riskLevel: 'write' as const,
    defaultApproval: 'require_approval' as const,
    execute,
    ...overrides,
  } as unknown as ToolDefinition<z.ZodTypeAny, unknown>;
  return { tool, execute };
}

const AUTONOMIES: Array<[string, Autonomy]> = [
  ['undefined (the shipped default)', undefined],
  ['propose_confirm', 'propose_confirm'],
  ['destructive_gate', 'destructive_gate'],
  ['fully_autonomous', 'fully_autonomous'],
];

describe('MCP-001 — a third-party MCP tool is gated with no approval rule', () => {
  for (const [label, autonomy] of AUTONOMIES) {
    // fully_autonomous is the owner's explicit "no prompts" decision, and the
    // gate honours it — that branch is asserted separately below.
    if (autonomy === 'fully_autonomous') continue;

    it(`suspends for approval under autonomy=${label}`, async () => {
      const { tool, execute } = makeMcpTool();
      // Capture the gate request itself: asserting on the real payload the
      // runner would surface, not merely that a callback fired.
      const gated: Array<{ toolName: string }> = [];

      const result = await executeTool(tool, {}, makeCtx(), {
        approvalRules: [], // the state right after attaching a server
        autonomy,
        onApprovalRequired: async (req) => {
          gated.push({ toolName: req.toolName });
        },
      });

      expect(result.outcome).toBe('awaiting_approval');
      expect(execute).not.toHaveBeenCalled();
      expect(gated).toEqual([{ toolName: 'veille__purge_all_data' }]);
    });
  }

  it('still honours fully_autonomous — the owner opted out of prompts', async () => {
    const { tool, execute } = makeMcpTool();
    const result = await executeTool(tool, {}, makeCtx(), {
      approvalRules: [],
      autonomy: 'fully_autonomous',
      onApprovalRequired: async () => {},
    });
    expect(result.outcome).toBe('success');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('runs without a prompt once the user grants standing consent', async () => {
    const { tool, execute } = makeMcpTool();
    const result = await executeTool(tool, {}, makeCtx(), {
      approvalRules: [
        {
          id: 'rule-1',
          toolName: 'veille__purge_all_data',
          action: 'auto_approve',
          agentId: 'agent-1',
          entityId: 'entity-1',
        },
      ],
      autonomy: undefined,
      onApprovalRequired: async () => {},
    });
    expect(result.outcome).toBe('success');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('a self-declared readOnlyHint cannot lower the posture', async () => {
    // The server claiming to be read-only used to yield riskLevel 'read'. Even
    // if a future change reintroduced that, defaultApproval still gates.
    const { tool, execute } = makeMcpTool({ riskLevel: 'read' });
    const result = await executeTool(tool, {}, makeCtx(), {
      approvalRules: [],
      autonomy: 'destructive_gate',
      onApprovalRequired: async () => {},
    });
    expect(result.outcome).toBe('awaiting_approval');
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('MCP-001 — control case: the gate itself works', () => {
  it('executes an ordinary tool that declares no approval posture', async () => {
    // Proves the suspensions above come from `defaultApproval`, not from the
    // gate refusing everything.
    const execute = vi.fn(async () => ({ ok: true }));
    const ordinary = {
      name: 'list_models',
      description: 'List models.',
      inputSchema: z.object({}),
      riskLevel: 'read' as const,
      execute,
    } as unknown as ToolDefinition<z.ZodTypeAny, unknown>;

    const result = await executeTool(ordinary, {}, makeCtx(), {
      approvalRules: [],
      autonomy: undefined,
      onApprovalRequired: async () => {},
    });
    expect(result.outcome).toBe('success');
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('create_mcp stdio is floored in every autonomy mode', () => {
  for (const [label, autonomy] of AUTONOMIES) {
    it(`requires a human under autonomy=${label}`, async () => {
      const execute = vi.fn(async () => ({ ok: true }));
      const createMcp = {
        name: 'create_mcp',
        description: 'Register an MCP server.',
        inputSchema: z.object({ transport: z.string().optional() }),
        riskLevel: 'write' as const,
        defaultApproval: 'require_approval' as const,
        execute,
      } as unknown as ToolDefinition<z.ZodTypeAny, unknown>;

      const result = await executeTool(
        createMcp,
        // stdio: spawns a local subprocess, RCE-equivalent to run_command.
        // É-2 gated this under destructive_gate; the gap was fully_autonomous,
        // which auto-approved before that branch was ever reached.
        { transport: 'stdio' },
        makeCtx(),
        { approvalRules: [], autonomy, onApprovalRequired: async () => {} },
      );

      expect(result.outcome).toBe('awaiting_approval');
      expect(execute).not.toHaveBeenCalled();
    });
  }

  it('leaves an http create_mcp on the existing É-2 path (no local spawn)', async () => {
    // Deliberately NOT floored: http spawns nothing, and every tool the attached
    // server exposes now carries its own defaultApproval (MCP-001), so attaching
    // one hands the model nothing it can run unattended.
    const execute = vi.fn(async () => ({ ok: true }));
    const createMcp = {
      name: 'create_mcp',
      description: 'Register an MCP server.',
      inputSchema: z.object({ transport: z.string().optional() }),
      riskLevel: 'write' as const,
      defaultApproval: 'require_approval' as const,
      execute,
    } as unknown as ToolDefinition<z.ZodTypeAny, unknown>;

    const result = await executeTool(createMcp, { transport: 'http' }, makeCtx(), {
      approvalRules: [],
      autonomy: 'destructive_gate',
      onApprovalRequired: async () => {},
    });
    expect(result.outcome).toBe('success');
  });

  it('is floored even against an explicit auto_approve rule', async () => {
    // An agent steered by injected content must not be able to hand itself a
    // permanent third-party channel, whatever rules exist.
    const execute = vi.fn(async () => ({ ok: true }));
    const createMcp = {
      name: 'create_mcp',
      description: 'Register an MCP server.',
      inputSchema: z.object({ transport: z.string().optional() }),
      riskLevel: 'write' as const,
      defaultApproval: 'require_approval' as const,
      execute,
    } as unknown as ToolDefinition<z.ZodTypeAny, unknown>;

    const result = await executeTool(createMcp, { transport: 'stdio' }, makeCtx(), {
      approvalRules: [
        {
          id: 'rule-yolo',
          toolName: 'create_mcp',
          action: 'auto_approve',
          agentId: 'agent-1',
          entityId: 'entity-1',
        },
      ],
      autonomy: 'fully_autonomous',
      onApprovalRequired: async () => {},
    });

    expect(result.outcome).toBe('awaiting_approval');
    expect(execute).not.toHaveBeenCalled();
  });
});
