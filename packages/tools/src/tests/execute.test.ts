// execute.test.ts — executeTool: success, validation error, runtime error,
// approval required (writes DB row), MessageStructureError re-throw

import { describe, it, expect, beforeAll } from 'vitest';
import { z } from 'zod';
import { eq } from '@nodalai/db';
import { spinUpTestDb, seedMinimal } from '@nodalai/db/test-utils';
import { approvalRequests, toolCalls } from '@nodalai/db';
import { MessageStructureError, QuotaExhaustedError } from '@nodalai/llm';
import { executeTool } from '../execute.js';
import type {
  ToolDefinition,
  ToolContext,
  ExecuteOptions,
  ApprovalGateRequest,
  ApprovalRule,
} from '../types.js';
import type { TestDb } from '@nodalai/db/test-utils';

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
});
