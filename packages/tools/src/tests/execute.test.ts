// execute.test.ts — executeTool: success, validation error, runtime error,
// approval required (writes DB row), MessageStructureError re-throw

import { describe, it, expect, beforeAll } from 'vitest';
import { z } from 'zod';
import { eq } from '@nodal-agents/db';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import { approvalRequests, toolCalls } from '@nodal-agents/db';
import { MessageStructureError, QuotaExhaustedError } from '@nodal-agents/llm';
import { executeTool } from '../execute';
import type {
  ToolDefinition,
  ToolContext,
  ExecuteOptions,
  ApprovalGateRequest,
  ApprovalRule,
} from '../types';
import type { TestDb } from '@nodal-agents/db/test-utils';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

type SimpleInput = { value: string };

function makeSimpleTool(
  override?: Partial<ToolDefinition<z.ZodObject<{ value: z.ZodString }>, string>>,
): ToolDefinition<z.ZodObject<{ value: z.ZodString }>, string> {
  return {
    name: 'simple_tool',
    description: 'Simple tool for testing',
    inputSchema: z.object({ value: z.string() }),
    riskLevel: 'read',
    execute: async (input: SimpleInput, _ctx: ToolContext) => `result:${input.value}`,
    ...override,
  };
}

function makeOpts(
  rules: ApprovalRule[] = [],
  onApproval?: (req: ApprovalGateRequest) => Promise<void>,
): ExecuteOptions {
  return {
    approvalRules: rules,
    onApprovalRequired: onApproval ?? (async () => {}),
  };
}

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    jobId: seed.jobId,
    agentId: seed.agentId,
    entityId: seed.entityId,
    db: db as unknown as ToolContext['db'],
    jobChatId: null,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('executeTool', () => {
  // ── Success path ────────────────────────────────────────────────────────────

  it('returns success with output on valid input', async () => {
    const result = await executeTool(makeSimpleTool(), { value: 'hello' }, makeCtx(), makeOpts());

    expect(result.outcome).toBe('success');
    if (result.outcome === 'success') {
      expect(result.output).toBe('result:hello');
    }
  });

  it('writes a tool_calls row on success', async () => {
    // Use a unique value to identify this specific call
    const uniqueVal = `write-test-${Date.now()}`;

    await executeTool(makeSimpleTool(), { value: uniqueVal }, makeCtx(), makeOpts());

    // Assert on the actual DB row — not just call counts (invariant 5)
    const calls = await db.select().from(toolCalls).where(eq(toolCalls.jobId, seed.jobId));

    expect(calls.length).toBeGreaterThan(0);
    const found = calls.find(
      (c) =>
        c.toolName === 'simple_tool' && (c.toolInput as { value?: string })?.value === uniqueVal,
    );
    expect(found).toBeDefined();
    expect(found?.toolOutput).toContain(`result:${uniqueVal}`);
    expect(found?.durationMs).toBeGreaterThanOrEqual(0);
  });

  // ── Validation error ────────────────────────────────────────────────────────

  it('returns error on invalid input (fails Zod validation)', async () => {
    const result = await executeTool(
      makeSimpleTool(),
      { value: 42 }, // string expected, got number
      makeCtx(),
      makeOpts(),
    );

    expect(result.outcome).toBe('error');
    if (result.outcome === 'error') {
      expect(result.error).toMatch(/invalid_input/);
    }
  });

  it('writes a tool_calls row even on validation error', async () => {
    const before = await db.select().from(toolCalls).where(eq(toolCalls.jobId, seed.jobId));

    await executeTool(
      makeSimpleTool(),
      { value: 99 }, // invalid — string expected
      makeCtx(),
      makeOpts(),
    );

    const after = await db.select().from(toolCalls).where(eq(toolCalls.jobId, seed.jobId));
    expect(after.length).toBeGreaterThan(before.length);
  });

  // ── Runtime error ────────────────────────────────────────────────────────────

  it('returns error when execute() throws a normal Error', async () => {
    const throwingTool = makeSimpleTool({
      execute: async () => {
        throw new Error('something_went_wrong');
      },
    });

    const result = await executeTool(throwingTool, { value: 'x' }, makeCtx(), makeOpts());
    expect(result.outcome).toBe('error');
    if (result.outcome === 'error') {
      expect(result.error).toBe('something_went_wrong');
    }
  });

  // ── MessageStructureError re-throw (critical invariant) ─────────────────────

  it('re-throws MessageStructureError — never wraps it', async () => {
    const fatalTool = makeSimpleTool({
      execute: async () => {
        throw new MessageStructureError('unresolved_tail', { toolCallId: 'tc1' });
      },
    });

    await expect(
      executeTool(fatalTool, { value: 'x' }, makeCtx(), makeOpts()),
    ).rejects.toBeInstanceOf(MessageStructureError);
  });

  it('re-throws QuotaExhaustedError — never wraps it', async () => {
    const quotaTool = makeSimpleTool({
      execute: async () => {
        throw new QuotaExhaustedError('openai', 'gpt-4', 'insufficient_quota');
      },
    });

    await expect(
      executeTool(quotaTool, { value: 'x' }, makeCtx(), makeOpts()),
    ).rejects.toBeInstanceOf(QuotaExhaustedError);
  });

  it('re-throws DelegationPendingError — assign_* tools rely on it as a control signal', async () => {
    // Constructed inline to avoid a circular dep on @nodal-agents/orchestration.
    // The runner detects this error by `name`, not instanceof, for the same reason.
    class DelegationPendingError extends Error {
      readonly code = 'delegation_pending' as const;
      constructor(
        public readonly childJobId: string,
        public readonly childSlug: string,
      ) {
        super(`delegation_pending: ${childSlug} (${childJobId})`);
        this.name = 'DelegationPendingError';
      }
    }

    const assignTool = makeSimpleTool({
      execute: async () => {
        throw new DelegationPendingError('child-job-1', 'worker-fr');
      },
    });

    await expect(
      executeTool(assignTool, { value: 'x' }, makeCtx(), makeOpts()),
    ).rejects.toMatchObject({ name: 'DelegationPendingError', code: 'delegation_pending' });
  });

  // ── Approval gate — require_approval ─────────────────────────────────────────

  it('inserts approval_requests row and returns awaiting_approval for require_approval rule', async () => {
    const destructiveTool = makeSimpleTool({
      name: 'dangerous_tool',
      riskLevel: 'destructive',
    });

    const rule: ApprovalRule = {
      id: 'rule-1',
      toolName: 'dangerous_tool',
      action: 'require_approval',
      agentId: seed.agentId,
      entityId: seed.entityId,
    };

    const capturedRequest: ApprovalGateRequest[] = [];
    const opts = makeOpts([rule], async (req) => {
      capturedRequest.push(req);
    });

    const result = await executeTool(destructiveTool, { value: 'delete-all' }, makeCtx(), opts);

    // 1. Returns awaiting_approval
    expect(result.outcome).toBe('awaiting_approval');

    // 2. onApprovalRequired was called with the request
    expect(capturedRequest).toHaveLength(1);
    expect(capturedRequest[0]?.toolName).toBe('dangerous_tool');

    // 3. DB row was inserted — assert on the real DB row (invariant 5)
    const approvalRequestId =
      result.outcome === 'awaiting_approval' ? result.approvalRequestId : null;
    expect(approvalRequestId).toBeTruthy();

    const rows = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalRequestId!));

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.toolName).toBe('dangerous_tool');
    expect(row.jobId).toBe(seed.jobId);
    expect(row.agentId).toBe(seed.agentId);
    expect(row.status).toBe('pending');
    // Assert the actual input was stored in the DB row
    expect((row.toolInput as { value?: string })?.value).toBe('delete-all');
  });

  // ── Approval gate — rule exempts tool (auto_approve) ────────────────────────

  it('executes without approval when rule is auto_approve', async () => {
    const tool = makeSimpleTool({ name: 'auto_tool', riskLevel: 'destructive' });

    const rule: ApprovalRule = {
      id: 'rule-auto',
      toolName: 'auto_tool',
      action: 'auto_approve',
      agentId: seed.agentId,
      entityId: seed.entityId,
    };

    const result = await executeTool(tool, { value: 'safe' }, makeCtx(), makeOpts([rule]));
    expect(result.outcome).toBe('success');
  });

  // ── Approval gate — block ────────────────────────────────────────────────────

  it('returns error with blocked when rule action is block', async () => {
    const tool = makeSimpleTool({ name: 'blocked_tool', riskLevel: 'destructive' });

    const rule: ApprovalRule = {
      id: 'rule-block',
      toolName: 'blocked_tool',
      action: 'block',
      agentId: seed.agentId,
      entityId: seed.entityId,
    };

    const result = await executeTool(tool, { value: 'x' }, makeCtx(), makeOpts([rule]));
    expect(result.outcome).toBe('error');
    if (result.outcome === 'error') {
      expect(result.error).toBe('blocked');
    }
  });

  // ── No rule — executes normally ──────────────────────────────────────────────

  it('executes without approval when no matching rule exists', async () => {
    const tool = makeSimpleTool({ name: 'unruled_tool', riskLevel: 'write' });

    // Rule exists for a different tool — should not match
    const rule: ApprovalRule = {
      id: 'rule-other',
      toolName: 'other_tool',
      action: 'require_approval',
      agentId: seed.agentId,
      entityId: seed.entityId,
    };

    const result = await executeTool(tool, { value: 'y' }, makeCtx(), makeOpts([rule]));
    expect(result.outcome).toBe('success');
  });

  // ── Rule specificity: agent-scoped wins over entity-scoped ──────────────────

  it('prefers agent-scoped rule over entity-scoped rule for same tool', async () => {
    const tool = makeSimpleTool({ name: 'contested_tool', riskLevel: 'write' });

    const entityRule: ApprovalRule = {
      id: 'entity-rule',
      toolName: 'contested_tool',
      action: 'require_approval',
      agentId: null,
      entityId: seed.entityId,
    };

    const agentRule: ApprovalRule = {
      id: 'agent-rule',
      toolName: 'contested_tool',
      action: 'auto_approve',
      agentId: seed.agentId,
      entityId: seed.entityId,
    };

    // Agent rule says auto_approve; entity rule says require_approval
    const result = await executeTool(
      tool,
      { value: 'z' },
      makeCtx(),
      makeOpts([entityRule, agentRule]),
    );

    // Agent-scoped auto_approve should win
    expect(result.outcome).toBe('success');
  });

  // ── Safe-by-default: tool.defaultApproval = 'require_approval' ───────────────
  // run_command opts into this so it suspends for approval when NO rule matches,
  // instead of inheriting the global no-rule→execute default (unsafe for a
  // shell-execution tool). A per-agent auto_approve rule ("Yolo") overrides it.

  it('suspends for approval when defaultApproval=require_approval and NO rule matches', async () => {
    const tool = makeSimpleTool({
      name: 'safe_default_tool',
      riskLevel: 'destructive',
      defaultApproval: 'require_approval',
    });

    const captured: ApprovalGateRequest[] = [];
    const result = await executeTool(
      tool,
      { value: 'rm -rf /' },
      makeCtx(),
      makeOpts([], async (req) => {
        captured.push(req);
      }),
    );

    expect(result.outcome).toBe('awaiting_approval');
    expect(captured).toHaveLength(1);

    // Real DB row, status pending, exact input preserved (the human reviews it).
    const id = result.outcome === 'awaiting_approval' ? result.approvalRequestId : null;
    const rows = await db.select().from(approvalRequests).where(eq(approvalRequests.id, id!));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.toolName).toBe('safe_default_tool');
    expect(rows[0]!.status).toBe('pending');
    expect((rows[0]!.toolInput as { value?: string })?.value).toBe('rm -rf /');
  });

  it('an auto_approve rule (Yolo) overrides defaultApproval=require_approval → executes', async () => {
    const tool = makeSimpleTool({
      name: 'yolo_tool',
      riskLevel: 'destructive',
      defaultApproval: 'require_approval',
    });

    const yoloRule: ApprovalRule = {
      id: 'yolo-rule',
      toolName: 'yolo_tool',
      action: 'auto_approve',
      agentId: seed.agentId,
      entityId: seed.entityId,
    };

    const captured: ApprovalGateRequest[] = [];
    const result = await executeTool(
      tool,
      { value: 'ok' },
      makeCtx(),
      makeOpts([yoloRule], async (req) => {
        captured.push(req);
      }),
    );

    expect(result.outcome).toBe('success');
    if (result.outcome === 'success') expect(result.output).toBe('result:ok');
    expect(captured).toHaveLength(0); // no approval was requested
  });

  it('a block rule still wins over defaultApproval=require_approval', async () => {
    const tool = makeSimpleTool({
      name: 'safe_default_blocked',
      riskLevel: 'destructive',
      defaultApproval: 'require_approval',
    });

    const blockRule: ApprovalRule = {
      id: 'sd-block',
      toolName: 'safe_default_blocked',
      action: 'block',
      agentId: seed.agentId,
      entityId: seed.entityId,
    };

    const result = await executeTool(tool, { value: 'x' }, makeCtx(), makeOpts([blockRule]));
    expect(result.outcome).toBe('error');
    if (result.outcome === 'error') expect(result.error).toBe('blocked');
  });

  it('REGRESSION: a tool WITHOUT defaultApproval and no rule still executes (default unchanged)', async () => {
    const tool = makeSimpleTool({ name: 'ordinary_tool', riskLevel: 'destructive' });
    // destructive risk, but no defaultApproval and no rule → historical behavior: execute.
    const result = await executeTool(tool, { value: 'q' }, makeCtx(), makeOpts([]));
    expect(result.outcome).toBe('success');
  });
});

// ─── Hardline floor for run_command ─────────────────────────────────────────────

function makeRunCommandTool(): ToolDefinition<z.ZodObject<{ command: z.ZodString }>, string> {
  return {
    name: 'run_command',
    description: 'run a shell command',
    inputSchema: z.object({ command: z.string() }),
    riskLevel: 'write',
    defaultApproval: 'require_approval',
    execute: async (input: { command: string }) => `ran:${input.command}`,
  };
}

describe('executeTool — run_command hardline floor', () => {
  function yoloRule(): ApprovalRule {
    return {
      id: 'yolo',
      toolName: 'run_command',
      action: 'auto_approve',
      agentId: seed.agentId,
      entityId: seed.entityId,
    };
  }

  it('Yolo auto-approves an ordinary command (control)', async () => {
    const res = await executeTool(
      makeRunCommandTool(),
      { command: 'ls -la' },
      makeCtx(),
      makeOpts([yoloRule()]),
    );
    expect(res.outcome).toBe('success'); // executed, no approval needed
  });

  it('Yolo CANNOT auto-approve a catastrophic command → forced to await approval', async () => {
    const res = await executeTool(
      makeRunCommandTool(),
      { command: 'rm -rf /' },
      makeCtx(),
      makeOpts([yoloRule()]),
    );
    // The floor overrides the auto_approve rule: a human must decide.
    expect(res.outcome).toBe('awaiting_approval');
  });

  it('floor applies to a chained catastrophic command too', async () => {
    const res = await executeTool(
      makeRunCommandTool(),
      { command: 'cd /tmp && sudo rm -rf /' },
      makeCtx(),
      makeOpts([yoloRule()]),
    );
    expect(res.outcome).toBe('awaiting_approval');
  });
});
