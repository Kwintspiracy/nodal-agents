// approval-rule-scope.test.ts — setAgentApprovalRuleAction writes REAL rows.
//
// The bug this locks down: the action used to DELETE on `auto_approve`, on the
// reasoning that "no rule" already meant auto-approve. MCP-001 made that false —
// every tool from a third-party MCP server now ships
// `defaultApproval: 'require_approval'`, so for those tools "no rule" means
// GATED. The approvals card's "always allow this server" button therefore
// reported success, wrote nothing, and the owner kept being asked on every call.
//
// Asserts on rows, never on call counts (CLAUDE.md invariant 5) — a call-count
// test would have passed throughout the entire life of the bug.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, and, isNull, approvalRules } from '@nodal-agents/db';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

vi.mock('@/lib/server.ts', () => ({
  getDb: () => testDb,
  getAuthProvider: () => ({ name: 'local-trust' }),
  applyActiveEntity: (session: { userId: string; entityId?: string }) => ({
    ...session,
    entityId: seed?.entityId ?? session.entityId ?? '',
  }),
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ set: () => {}, get: () => null, delete: () => {} }),
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

vi.mock('@nodal-agents/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/auth')>();
  return {
    ...actual,
    requireAuth: async () => ({
      userId: 'mock-user-id',
      entityId: seed?.entityId ?? 'mock-entity-id',
    }),
  };
});

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);
});

async function rulesFor(toolName: string) {
  return testDb
    .select()
    .from(approvalRules)
    .where(and(eq(approvalRules.entityId, seed.entityId), eq(approvalRules.toolName, toolName)));
}

describe('setAgentApprovalRuleAction — auto_approve must PERSIST', () => {
  it('writes an agent-scoped row for a per-server MCP grant', async () => {
    const { setAgentApprovalRuleAction } = await import('../actions.ts');

    const r = await setAgentApprovalRuleAction({
      agentId: seed.agentId,
      toolName: 'cogni_cortex__*',
      action: 'auto_approve',
    });
    expect(r.ok).toBe(true);

    const rows = await rulesFor('cogni_cortex__*');
    // The whole point: a row EXISTS. The old branch left zero and said ok.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('auto_approve');
    expect(rows[0]!.agentId).toBe(seed.agentId);
  });

  it('scope=entity writes agent_id NULL — the "all my agents" grant', async () => {
    const { setAgentApprovalRuleAction } = await import('../actions.ts');

    const r = await setAgentApprovalRuleAction({
      agentId: seed.agentId,
      toolName: 'veille__*',
      action: 'auto_approve',
      scope: 'entity',
    });
    expect(r.ok).toBe(true);

    const [row] = await testDb
      .select()
      .from(approvalRules)
      .where(
        and(
          eq(approvalRules.entityId, seed.entityId),
          eq(approvalRules.toolName, 'veille__*'),
          isNull(approvalRules.agentId),
        ),
      );
    expect(row?.action).toBe('auto_approve');
  });

  it('action=null still deletes — reverting to the tool’s own default', async () => {
    const { setAgentApprovalRuleAction } = await import('../actions.ts');

    await setAgentApprovalRuleAction({
      agentId: seed.agentId,
      toolName: 'to_revert__*',
      action: 'auto_approve',
    });
    expect(await rulesFor('to_revert__*')).toHaveLength(1);

    await setAgentApprovalRuleAction({
      agentId: seed.agentId,
      toolName: 'to_revert__*',
      action: null,
    });
    expect(await rulesFor('to_revert__*')).toHaveLength(0);
  });

  it('is idempotent — clicking twice leaves ONE row, not two divergent ones', async () => {
    const { setAgentApprovalRuleAction } = await import('../actions.ts');

    await setAgentApprovalRuleAction({
      agentId: seed.agentId,
      toolName: 'twice__*',
      action: 'auto_approve',
    });
    await setAgentApprovalRuleAction({
      agentId: seed.agentId,
      toolName: 'twice__*',
      action: 'require_approval',
    });

    const rows = await rulesFor('twice__*');
    // Two rows for one scope would make matchApprovalRule's `.find()`
    // non-deterministic — the gate would depend on SELECT order.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('require_approval');
  });

  it('agent-scoped and entity-scoped rows for the same tool coexist', async () => {
    const { setAgentApprovalRuleAction } = await import('../actions.ts');

    await setAgentApprovalRuleAction({
      agentId: seed.agentId,
      toolName: 'both__*',
      action: 'require_approval',
    });
    await setAgentApprovalRuleAction({
      agentId: seed.agentId,
      toolName: 'both__*',
      action: 'auto_approve',
      scope: 'entity',
    });

    // Distinct scopes, distinct rows — the unique index is
    // (entity, agent-or-null, tool). matchApprovalRule ranks the agent row
    // first, so a per-agent `require_approval` survives a workspace-wide grant.
    const rows = await rulesFor('both__*');
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.agentId === seed.agentId)?.action).toBe('require_approval');
    expect(rows.find((r) => r.agentId === null)?.action).toBe('auto_approve');
  });
});
