// inject.test.ts — selectMemoriesUnderBudget (pure) + selectMemoriesForInjection (DB)

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import { agentMemory } from '@nodal-agents/db';
import type { AgentMemory } from '@nodal-agents/shared';
import { selectMemoriesUnderBudget, selectMemoriesForInjection } from '../inject';
import { createMemory } from '../crud';

// ─── Pure helper tests ────────────────────────────────────────────────────────

function makeMem(
  id: string,
  fact: string,
  importance: number,
  lastAccessed?: string,
): AgentMemory {
  return {
    id,
    entity_id: '00000000-0000-0000-0000-000000000001',
    agent_id: null,
    fact,
    category: 'context',
    importance: importance as 1 | 2 | 3 | 4 | 5,
    source: 'agent',
    skill_tags: [],
    memory_layer: null,
    valid_from: '2026-01-01T00:00:00.000Z',
    valid_to: null,
    fact_hash: null,
    archived: false,
    last_accessed_at: lastAccessed ?? '2026-01-01T00:00:00.000Z',
    access_count: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

describe('selectMemoriesUnderBudget — pure', () => {
  it('returns [] when budget is 0 or negative', () => {
    const mems = [makeMem('a', 'foo', 5)];
    expect(selectMemoriesUnderBudget(mems, 0)).toEqual([]);
    expect(selectMemoriesUnderBudget(mems, -100)).toEqual([]);
  });

  it('returns [] when input is empty', () => {
    expect(selectMemoriesUnderBudget([], 1500)).toEqual([]);
  });

  it('sorts by importance DESC before packing', () => {
    const low = makeMem('low', 'low-fact', 1);
    const high = makeMem('high', 'high-fact', 5);
    const mid = makeMem('mid', 'mid-fact', 3);
    const out = selectMemoriesUnderBudget([low, high, mid], 10_000);
    expect(out.map((m) => m.id)).toEqual(['high', 'mid', 'low']);
  });

  it('breaks importance ties by recency (last_accessed_at DESC)', () => {
    const older = makeMem('older', 'fact-older', 4, '2026-01-01T00:00:00.000Z');
    const newer = makeMem('newer', 'fact-newer', 4, '2026-05-15T12:00:00.000Z');
    const out = selectMemoriesUnderBudget([older, newer], 10_000);
    expect(out.map((m) => m.id)).toEqual(['newer', 'older']);
  });

  it('greedy-packs under the char budget, skipping items that would overflow', () => {
    const big = makeMem('big', 'X'.repeat(1000), 5);
    const small = makeMem('small', 'tiny', 5);
    // big costs 1000 + 20 = 1020. small costs 4 + 20 = 24. budget 100 → only `small` fits.
    const out = selectMemoriesUnderBudget([big, small], 100);
    expect(out.map((m) => m.id)).toEqual(['small']);
  });

  it('packs as many as fit when total cost is under budget', () => {
    const a = makeMem('a', 'fact-a', 5); // 6 + 20 = 26
    const b = makeMem('b', 'fact-b', 4); // 26
    const c = makeMem('c', 'fact-c', 3); // 26
    const out = selectMemoriesUnderBudget([a, b, c], 200);
    expect(out.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the input array', () => {
    const a = makeMem('a', 'A', 1);
    const b = makeMem('b', 'B', 5);
    const input = [a, b];
    selectMemoriesUnderBudget(input, 1000);
    expect(input).toEqual([a, b]); // order untouched
  });
});

// ─── DB-bound integration ─────────────────────────────────────────────────────

let db: Awaited<ReturnType<typeof spinUpTestDb>>['db'];
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
});

describe('selectMemoriesForInjection — DB', () => {
  it('returns [] when budget is 0', async () => {
    const out = await selectMemoriesForInjection(db, { entityId: seed.entityId, maxChars: 0 });
    expect(out).toEqual([]);
  });

  it('returns top memories under budget, ordered by importance × recency', async () => {
    // Wipe any pre-existing memory rows for this entity to isolate the test
    await db.delete(agentMemory);

    await createMemory(db, {
      entity_id: seed.entityId,
      agent_id: seed.agentId,
      fact: 'high-priority context',
      category: 'context',
      importance: 5,
      source: 'agent',
      skill_tags: [],
    });
    await createMemory(db, {
      entity_id: seed.entityId,
      agent_id: seed.agentId,
      fact: 'low-priority context',
      category: 'context',
      importance: 1,
      source: 'agent',
      skill_tags: [],
    });

    const out = await selectMemoriesForInjection(db, {
      entityId: seed.entityId,
      maxChars: 1500,
    });
    expect(out.length).toBe(2);
    expect(out[0]?.importance).toBe(5);
    expect(out[1]?.importance).toBe(1);
  });

  it('excludes archived memories', async () => {
    await db.delete(agentMemory);
    const kept = await createMemory(db, {
      entity_id: seed.entityId,
      agent_id: seed.agentId,
      fact: 'kept fact',
      category: 'context',
      importance: 3,
      source: 'agent',
      skill_tags: [],
    });
    const archived = await createMemory(db, {
      entity_id: seed.entityId,
      agent_id: seed.agentId,
      fact: 'archived fact',
      category: 'context',
      importance: 5,
      source: 'agent',
      skill_tags: [],
    });
    // Archive the high-importance one — it should NOT be returned even though
    // its importance is higher
    await db.update(agentMemory).set({ archived: true });
    // Un-archive the kept one
    await db.update(agentMemory).set({ archived: false }).where(eqColumn(kept.id));

    const out = await selectMemoriesForInjection(db, {
      entityId: seed.entityId,
      maxChars: 1500,
    });
    expect(out.map((m) => m.id)).toEqual([kept.id]);
    expect(out.find((m) => m.id === archived.id)).toBeUndefined();
  });
});

// Small helper to avoid eq import cycle in test file
import { eq } from '@nodal-agents/db';
function eqColumn(id: string) {
  return eq(agentMemory.id, id);
}
