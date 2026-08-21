// preflight-order.test.ts — a refusal must land BEFORE the approval card.
//
// From the PR #6 review (2026-08-21). The security fix that refuses codex on
// platforms where its sandbox is not enforced justified itself with "the choice
// is not offered rather than offered on false terms". It was offered: the guard
// sat in `execute()`, and `executeTool` only reaches `execute` AFTER writing an
// approval request and getting a human's approval. The human saw a card
// promising confinement, approved it, and only then got the refusal.
//
// The nine unit tests on the guard itself were all green throughout, because
// they called the guard directly. Ordering is a property of the WIRING, and only
// a test that drives the real `executeTool` can see it — which is exactly what
// the review said was missing.
//
// These cases pin the order against the real executeTool, with a real DB.

import { describe, it, expect, beforeAll } from 'vitest';
import { z } from 'zod';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { executeTool } from '../execute';
import type { ToolContext, ToolDefinition, ApprovalGateRequest, ExecuteOptions } from '../types';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

function makeCtx(): ToolContext {
  return {
    db,
    entityId: seed.entityId,
    agentId: seed.agentId,
    jobId: seed.jobId,
  } as unknown as ToolContext;
}

/**
 * A tool shaped like `code_task` where it matters: safe-by-default (so the
 * approval gate is armed) and refusing in preflight.
 */
function makeGatedTool(opts: {
  refuseInPreflight?: boolean;
  refuseInExecute?: boolean;
}): ToolDefinition<z.ZodObject<{ value: z.ZodString }>, string> {
  return {
    name: 'gated_tool',
    description: 'Safe-by-default tool used to pin refusal ordering',
    inputSchema: z.object({ value: z.string() }),
    riskLevel: 'destructive',
    defaultApproval: 'require_approval',
    ...(opts.refuseInPreflight
      ? {
          preflight: () => {
            throw new Error('refused_in_preflight: this call cannot be honoured here');
          },
        }
      : {}),
    execute: async () => {
      if (opts.refuseInExecute) throw new Error('refused_in_execute');
      return 'ran';
    },
  };
}

describe('preflight runs before the approval gate', () => {
  it('refuses without ever creating an approval request', async () => {
    // THE case. Before the fix this returned 'awaiting_approval' and the human
    // was handed a card for a call that could never run.
    const asked: ApprovalGateRequest[] = [];
    const optsWithSpy: ExecuteOptions = {
      approvalRules: [],
      onApprovalRequired: async (req) => {
        asked.push(req);
      },
    };

    const result = await executeTool(
      makeGatedTool({ refuseInPreflight: true }),
      { value: 'x' },
      makeCtx(),
      optsWithSpy,
    );

    expect(result.outcome, 'the call was offered for approval instead of refused').toBe('error');
    if (result.outcome !== 'error') return;
    expect(result.error).toMatch(/refused_in_preflight/);
    expect(asked, 'a human was asked to approve a call that cannot run').toHaveLength(0);
  });

  it('still refuses under an explicit auto_approve rule', async () => {
    // A "Yolo" rule bypasses the card entirely. A refusal that only fires on the
    // approval path would let exactly this configuration through — and it is the
    // configuration a power user runs.
    const result = await executeTool(
      makeGatedTool({ refuseInPreflight: true }),
      { value: 'x' },
      makeCtx(),
      {
        approvalRules: [
          {
            toolName: 'gated_tool',
            action: 'auto_approve',
            agentId: seed.agentId,
            entityId: seed.entityId,
          } as never,
        ],
        onApprovalRequired: async () => {},
      },
    );

    expect(result.outcome).toBe('error');
    if (result.outcome !== 'error') return;
    expect(result.error).toMatch(/refused_in_preflight/);
  });

  it('still refuses under fully_autonomous', async () => {
    // Same reasoning, via the autonomy level rather than a rule.
    const result = await executeTool(
      makeGatedTool({ refuseInPreflight: true }),
      { value: 'x' },
      makeCtx(),
      {
        approvalRules: [],
        autonomy: 'fully_autonomous',
        onApprovalRequired: async () => {},
      } as ExecuteOptions,
    );

    expect(result.outcome).toBe('error');
    if (result.outcome !== 'error') return;
    expect(result.error).toMatch(/refused_in_preflight/);
  });

  it('leaves the ordinary gate alone when preflight passes', async () => {
    // The over-broad-fix check: a tool with no preflight objection must still
    // reach the approval gate exactly as before. A guard that swallows the gate
    // would be a regression dressed as a security fix.
    const asked: ApprovalGateRequest[] = [];
    const result = await executeTool(makeGatedTool({}), { value: 'x' }, makeCtx(), {
      approvalRules: [],
      onApprovalRequired: async (req) => {
        asked.push(req);
      },
    });

    expect(result.outcome).toBe('awaiting_approval');
    expect(asked, 'the approval request disappeared').toHaveLength(1);
  });

  it('a tool without preflight is untouched', async () => {
    const result = await executeTool(
      {
        name: 'plain_tool',
        description: 'no preflight at all',
        inputSchema: z.object({ value: z.string() }),
        riskLevel: 'read',
        execute: async () => 'ran',
      } as ToolDefinition<z.ZodObject<{ value: z.ZodString }>, string>,
      { value: 'x' },
      makeCtx(),
      { approvalRules: [], onApprovalRequired: async () => {} },
    );

    expect(result.outcome).toBe('success');
  });
});
