// review-loop.test.ts — étape C: the structured review verdict, the
// prescriptive block message, and the read-only write-guard on code_task.
// Real assertions on real outputs and real pglite rows (invariant 5).

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal, type TestDb } from '@nodal-agents/db/test-utils';
import { approvalRules } from '@nodal-agents/db';
import { executeTool } from '../execute';
import type { ToolContext, ExecuteOptions, ApprovalRule } from '../types';
import { reviewVerdictTool } from '../builtin/review-verdict';
import { assertNotReadOnlyAgent, ReadOnlyAgentError } from '../builtin/code-task/db';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

function makeCtx(): ToolContext {
  return {
    jobId: seed.jobId,
    agentId: seed.agentId,
    entityId: seed.entityId,
    db: db as unknown as ToolContext['db'],
    jobChatId: null,
  };
}

function makeOpts(rules: ApprovalRule[] = []): ExecuteOptions {
  return { approvalRules: rules, onApprovalRequired: async () => {} };
}

// ─── review_verdict ──────────────────────────────────────────────────────────

describe('review_verdict', () => {
  it('approve with minor findings passes and counts severities', async () => {
    const result = await executeTool(
      reviewVerdictTool,
      {
        verdict: 'approve',
        summary: 'Relu les 3 fichiers modifiés, tests passés localement.',
        findings: [
          { file: 'src/a.ts', line: 12, issue: 'nom de variable trompeur', severity: 'minor' },
        ],
      },
      makeCtx(),
      makeOpts(),
    );
    expect(result.outcome).toBe('success');
    if (result.outcome === 'success') {
      const out = result.output as { verdict: string; counts: Record<string, number> };
      expect(out.verdict).toBe('approve');
      expect(out.counts).toEqual({ blocker: 0, major: 0, minor: 1 });
    }
  });

  it('request_changes WITHOUT findings is rejected with the explicit reason', async () => {
    const result = await executeTool(
      reviewVerdictTool,
      { verdict: 'request_changes', summary: 'non', findings: [] },
      makeCtx(),
      makeOpts(),
    );
    expect(result.outcome).toBe('error');
    if (result.outcome === 'error') {
      expect(result.error).toMatch(/at least one finding/);
    }
  });

  it('approve carrying a blocker finding is rejected', async () => {
    const result = await executeTool(
      reviewVerdictTool,
      {
        verdict: 'approve',
        summary: 'ok mais...',
        findings: [{ file: 'src/a.ts', issue: 'perd des données', severity: 'blocker' }],
      },
      makeCtx(),
      makeOpts(),
    );
    expect(result.outcome).toBe('error');
    if (result.outcome === 'error') {
      expect(result.error).toMatch(/approve cannot carry blocker/);
    }
  });
});

// ─── Prescriptive block message ──────────────────────────────────────────────

describe('blocked tool message', () => {
  it('names the tool and forbids workarounds (no more bare "blocked")', async () => {
    const rules: ApprovalRule[] = [
      {
        id: 'r1',
        toolName: 'review_verdict',
        action: 'block',
        agentId: seed.agentId,
        entityId: seed.entityId,
      },
    ];
    const result = await executeTool(
      reviewVerdictTool,
      { verdict: 'approve', summary: 'x', findings: [] },
      makeCtx(),
      makeOpts(rules),
    );
    expect(result.outcome).toBe('error');
    if (result.outcome === 'error') {
      expect(result.error).toContain('blocked');
      expect(result.error).toContain('review_verdict');
      expect(result.error).toMatch(/do NOT retry/i);
    }
  });
});

// ─── Read-only write-guard (code_task mode write) ────────────────────────────

describe('assertNotReadOnlyAgent', () => {
  it('passes when no block rule exists, throws once file_write is blocked', async () => {
    const dbh = db as unknown as ToolContext['db'];
    await assertNotReadOnlyAgent(dbh, seed.agentId); // no rule yet — passes

    await db.insert(approvalRules).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      toolName: 'file_write',
      action: 'block',
    });
    await expect(assertNotReadOnlyAgent(dbh, seed.agentId)).rejects.toThrow(ReadOnlyAgentError);
    await expect(assertNotReadOnlyAgent(dbh, seed.agentId)).rejects.toThrow(
      /read_only_agent_write_mode/,
    );
  });
});
