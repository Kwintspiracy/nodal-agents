// Test: the approval_rules SELECT + ORDER BY that execute.ts (job/execute.ts,
// "── 8. Load approval rules ──") runs before building `approvalRuleList` is a
// deterministic, specificity-first order — regardless of physical row/insert
// order. Audit #2 DB-1: matchApprovalRule (packages/tools/src/execute.ts)
// picks the first row matching each priority tier via `.find()`; an unordered
// SELECT made that pick depend on whatever order Postgres happened to return
// rows in.

import { describe, it, expect, beforeAll } from 'vitest';
import { eq, sql } from '@nodal-agents/db';
import { approvalRules } from '@nodal-agents/db';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { matchApprovalRule } from '@nodal-agents/tools';
import type { ApprovalRule } from '@nodal-agents/tools';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

// Mirrors the exact query in apps/runner/src/job/execute.ts step 8.
async function loadOrderedRules(entityId: string): Promise<ApprovalRule[]> {
  const rows = await db
    .select()
    .from(approvalRules)
    .where(eq(approvalRules.entityId, entityId))
    .orderBy(
      sql`${approvalRules.agentId} IS NULL`,
      sql`${approvalRules.toolName} = '*'`,
      approvalRules.id,
    );
  return rows.map((r) => ({
    id: r.id,
    toolName: r.toolName,
    action: (r.action ?? 'auto_approve') as ApprovalRule['action'],
    agentId: r.agentId,
    entityId: r.entityId,
  }));
}

describe('approval_rules load order — DB-1 (audit #2)', () => {
  it('returns agent-scoped-exact, agent-scoped-wildcard, entity-wide-exact, entity-wide-wildcard, in that order', async () => {
    const toolName = `order-test-tool-${Date.now()}`;

    // Inserted deliberately OUT of priority order.
    const [entityWildcard] = await db
      .insert(approvalRules)
      .values({ entityId: seed.entityId, agentId: null, toolName: '*', action: 'require_approval' })
      .returning();
    const [agentExact] = await db
      .insert(approvalRules)
      .values({ entityId: seed.entityId, agentId: seed.agentId, toolName, action: 'block' })
      .returning();
    const [entityExact] = await db
      .insert(approvalRules)
      .values({ entityId: seed.entityId, agentId: null, toolName, action: 'auto_approve' })
      .returning();
    const [agentWildcard] = await db
      .insert(approvalRules)
      .values({ entityId: seed.entityId, agentId: seed.agentId, toolName: '*', action: 'block' })
      .returning();

    const ordered = await loadOrderedRules(seed.entityId);
    const orderedIds = ordered.map((r) => r.id);

    expect(orderedIds).toEqual([
      agentExact!.id,
      agentWildcard!.id,
      entityExact!.id,
      entityWildcard!.id,
    ]);
  });

  it('matchApprovalRule picks the agent-scoped exact-tool rule regardless of the array coming pre-sorted this way', async () => {
    const toolName = `order-test-match-${Date.now()}`;
    await db
      .insert(approvalRules)
      .values({ entityId: seed.entityId, agentId: null, toolName, action: 'auto_approve' });
    await db
      .insert(approvalRules)
      .values({ entityId: seed.entityId, agentId: seed.agentId, toolName, action: 'block' });

    const ordered = await loadOrderedRules(seed.entityId);
    const match = matchApprovalRule(ordered, toolName, seed.agentId, seed.entityId);

    expect(match?.action).toBe('block');
    expect(match?.agentId).toBe(seed.agentId);
  });
});
