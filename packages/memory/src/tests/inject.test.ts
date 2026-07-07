// inject.test.ts — selectMemoriesUnderBudget (pure) + selectMemoriesForInjection (DB)

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import { agentMemory } from '@nodal-agents/db';
import type { AgentMemory } from '@nodal-agents/shared';
import { selectMemoriesUnderBudget, selectMemoriesForInjection } from '../inject';
import { createMemory } from '../crud';

// ─── Pure helper tests ────────────────────────────────────────────────────────

function makeMem(id: string, fact: string, importance: number, lastAccessed?: string): AgentMemory {
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
    importance_locked: false,
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

describe('selectMemoriesUnderBudget — relevance ranking (Brick 1)', () => {
  it('boosts task-relevant facts above higher-importance irrelevant ones', () => {
    const irrelevant = makeMem('irrelevant', 'the office is in Paris', 5);
    const relevant = makeMem('relevant', 'client email templates live in Drive', 2);
    // relevant: importance 2 + 2 keyword hits (client,email) → score 6; irrelevant: 5
    const out = selectMemoriesUnderBudget(
      [irrelevant, relevant],
      10_000,
      'send the client email report',
    );
    expect(out.map((m) => m.id)).toEqual(['relevant', 'irrelevant']);
  });

  it('without a query, ranking is unchanged (pure importance) — backward compatible', () => {
    const irrelevant = makeMem('irrelevant', 'the office is in Paris', 5);
    const relevant = makeMem('relevant', 'client email templates live in Drive', 2);
    const out = selectMemoriesUnderBudget([irrelevant, relevant], 10_000);
    expect(out.map((m) => m.id)).toEqual(['irrelevant', 'relevant']);
  });

  it('a single weak keyword hit does NOT override a much-higher importance fact', () => {
    // relevant: importance 1 + 1 hit (email) → 3; high: importance 5 → 5. Importance wins.
    const high = makeMem('high', 'unrelated but critical', 5);
    const weak = makeMem('weak', 'email signature line', 1);
    const out = selectMemoriesUnderBudget([high, weak], 10_000, 'send an email');
    expect(out[0]?.id).toBe('high');
  });

  it('when the budget fits only one, picks the on-topic fact over the off-topic one', () => {
    const offTopic = makeMem('off', 'X'.repeat(60), 4); // importance 4, no match, cost 80
    const onTopic = makeMem('on', 'deploy the staging server tonight', 2); // 2 hits, cost 53
    const out = selectMemoriesUnderBudget([offTopic, onTopic], 60, 'deploy to staging now');
    expect(out.map((m) => m.id)).toEqual(['on']);
  });

  it('matches across French accents/casing (Unicode tokenizer)', () => {
    const relevant = makeMem('rel', 'génère une facture pour le client', 2);
    const other = makeMem('other', 'random unrelated note', 4);
    // query lowercased tokens include "facture" + "client" → 2 hits → score 6 > 4
    const out = selectMemoriesUnderBudget([other, relevant], 10_000, 'Génère la FACTURE du client');
    expect(out[0]?.id).toBe('rel');
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

  it('relevance-ranks the fetched pool against the query (lower-importance but on-topic wins)', async () => {
    await db.delete(agentMemory);
    await createMemory(db, {
      entity_id: seed.entityId,
      agent_id: seed.agentId,
      fact: 'quarterly revenue is up 12 percent',
      category: 'context',
      importance: 5,
      source: 'agent',
      skill_tags: [],
    });
    await createMemory(db, {
      entity_id: seed.entityId,
      agent_id: seed.agentId,
      fact: 'the email server uses port 587 with TLS',
      category: 'context',
      importance: 2,
      source: 'agent',
      skill_tags: [],
    });

    const out = await selectMemoriesForInjection(db, {
      entityId: seed.entityId,
      maxChars: 1500,
      query: 'configure the email server',
    });
    // On-topic (importance 2, hits email+server) outranks the importance-5 fact.
    expect(out[0]?.fact).toContain('email server');
  });

  it('stems the task — a "token" task surfaces a fact containing "tokens" (english config)', async () => {
    await db.delete(agentMemory);
    await createMemory(db, {
      entity_id: seed.entityId,
      agent_id: seed.agentId,
      fact: 'refresh tokens rotate weekly',
      category: 'context',
      importance: 2,
      source: 'agent',
      skill_tags: [],
    });
    await createMemory(db, {
      entity_id: seed.entityId,
      agent_id: seed.agentId,
      fact: 'the office coffee machine is on the third floor',
      category: 'context',
      importance: 5,
      source: 'agent',
      skill_tags: [],
    });

    const out = await selectMemoriesForInjection(db, {
      entityId: seed.entityId,
      maxChars: 1500,
      query: 'rotate the token now',
    });
    expect(out[0]?.fact).toBe('refresh tokens rotate weekly');
  });

  it('surfaces a relevant-but-low-importance fact hidden past MAX_CANDIDATES(200) by the old importance/recency ordering', async () => {
    await db.delete(agentMemory);

    // 200 higher-importance, query-irrelevant facts — under the pre-FTS
    // ordering (importance DESC, last_accessed_at DESC) these fill every slot
    // of the top-200 candidate pool, pushing the one relevant-but-low-importance
    // fact below the LIMIT 200 cutoff.
    for (let i = 0; i < 200; i++) {
      await createMemory(db, {
        entity_id: seed.entityId,
        agent_id: seed.agentId,
        fact: `filler fact number ${i} about nothing in particular`,
        category: 'context',
        importance: 5,
        source: 'agent',
        skill_tags: [],
      });
    }
    const target = await createMemory(db, {
      entity_id: seed.entityId,
      agent_id: seed.agentId,
      fact: 'the printer configuration lives in the shared network folder',
      category: 'context',
      importance: 1,
      source: 'agent',
      skill_tags: [],
    });

    // Without a query: falls back to the old importance/recency ordering —
    // the importance-1 fact is candidate #201, excluded by LIMIT 200.
    const withoutQuery = await selectMemoriesForInjection(db, {
      entityId: seed.entityId,
      maxChars: 50_000,
    });
    expect(withoutQuery.find((m) => m.id === target.id)).toBeUndefined();

    // With a query matching it: FTS ranks it #1 (only match; the 200 fillers
    // all rank 0), so it's inside the candidate pool and gets packed.
    const withQuery = await selectMemoriesForInjection(db, {
      entityId: seed.entityId,
      maxChars: 500,
      query: 'printer configuration shared folder',
    });
    expect(withQuery.some((m) => m.id === target.id)).toBe(true);
  });
});

// Small helper to avoid eq import cycle in test file
import { eq } from '@nodal-agents/db';
function eqColumn(id: string) {
  return eq(agentMemory.id, id);
}

// ─── Backward-compat: no/empty/all-stopword query falls back to the pre-FTS
// importance DESC → recency DESC ordering (Brick 1 must not regress this) ───
describe('selectMemoriesForInjection — backward-compat ordering (no usable query)', () => {
  it('with query omitted, orders purely by importance DESC then recency DESC', async () => {
    await db.delete(agentMemory);
    const low = await createMemory(db, {
      entity_id: seed.entityId,
      agent_id: seed.agentId,
      fact: 'low importance fact',
      category: 'context',
      importance: 1,
      source: 'agent',
      skill_tags: [],
    });
    const high = await createMemory(db, {
      entity_id: seed.entityId,
      agent_id: seed.agentId,
      fact: 'high importance fact',
      category: 'context',
      importance: 5,
      source: 'agent',
      skill_tags: [],
    });
    const mid = await createMemory(db, {
      entity_id: seed.entityId,
      agent_id: seed.agentId,
      fact: 'mid importance fact',
      category: 'context',
      importance: 3,
      source: 'agent',
      skill_tags: [],
    });

    const out = await selectMemoriesForInjection(db, { entityId: seed.entityId, maxChars: 5000 });
    expect(out.map((m) => m.id)).toEqual([high.id, mid.id, low.id]);
  });

  it('an empty-string query does not throw and falls back to importance/recency ordering', async () => {
    await db.delete(agentMemory);
    const low = await createMemory(db, {
      entity_id: seed.entityId,
      agent_id: seed.agentId,
      fact: 'low importance fact',
      category: 'context',
      importance: 1,
      source: 'agent',
      skill_tags: [],
    });
    const high = await createMemory(db, {
      entity_id: seed.entityId,
      agent_id: seed.agentId,
      fact: 'high importance fact',
      category: 'context',
      importance: 5,
      source: 'agent',
      skill_tags: [],
    });

    const out = await selectMemoriesForInjection(db, {
      entityId: seed.entityId,
      maxChars: 5000,
      query: '',
    });
    expect(out.map((m) => m.id)).toEqual([high.id, low.id]);
  });

  it('an all-stopwords task ("the and but") does not throw an invalid tsquery and falls back to importance/recency', async () => {
    await db.delete(agentMemory);
    const low = await createMemory(db, {
      entity_id: seed.entityId,
      agent_id: seed.agentId,
      fact: 'low importance fact',
      category: 'context',
      importance: 1,
      source: 'agent',
      skill_tags: [],
    });
    const high = await createMemory(db, {
      entity_id: seed.entityId,
      agent_id: seed.agentId,
      fact: 'high importance fact',
      category: 'context',
      importance: 5,
      source: 'agent',
      skill_tags: [],
    });

    await expect(
      selectMemoriesForInjection(db, {
        entityId: seed.entityId,
        maxChars: 5000,
        query: 'the and but',
      }),
    ).resolves.not.toThrow();

    const out = await selectMemoriesForInjection(db, {
      entityId: seed.entityId,
      maxChars: 5000,
      query: 'the and but',
    });
    // tokenizeQuery strips all of "the"/"and"/"but" as stopwords → tokens=[]
    // → same code path (and ordering) as no query at all.
    expect(out.map((m) => m.id)).toEqual([high.id, low.id]);
  });

  // M-1 (deep audit): injecting a memory counts as USING it — access_count must
  // bump, or the curator's "access_count = 0 → archive" sweep devalues facts that
  // are actively being injected.
  it('bumps access_count / last_accessed_at for the injected memories (M-1)', async () => {
    await db.delete(agentMemory);
    const m = await createMemory(db, {
      entity_id: seed.entityId,
      agent_id: seed.agentId,
      fact: 'comfyui workflow settings the agent relies on',
      category: 'context',
      importance: 3,
      source: 'agent',
      skill_tags: [],
    });

    const before = await db.select().from(agentMemory).where(eqColumn(m.id));
    expect(before[0]?.accessCount ?? 0).toBe(0);

    const out = await selectMemoriesForInjection(db, {
      entityId: seed.entityId,
      maxChars: 1500,
      query: 'comfyui workflow',
    });
    expect(out.map((x) => x.id)).toContain(m.id);

    const after = await db.select().from(agentMemory).where(eqColumn(m.id));
    expect(after[0]?.accessCount ?? 0).toBeGreaterThanOrEqual(1);
    expect(after[0]?.lastAccessedAt).not.toBeNull();
  });

  // M-2 (deep audit): a multi-word task query must OR its terms — a partially
  // on-topic memory should beat a high-importance off-topic one. plainto_tsquery
  // (AND every term) collapsed ts_rank to 0 for all rows, silently degrading the
  // "FTS-authoritative" order to importance-only.
  it('ORs multi-word queries so a partial-topic match beats a high-importance off-topic one (M-2)', async () => {
    await db.delete(agentMemory);
    const onTopic = await createMemory(db, {
      entity_id: seed.entityId,
      agent_id: seed.agentId,
      fact: 'comfyui checkpoint sdxl base model path',
      category: 'context',
      importance: 1,
      source: 'agent',
      skill_tags: [],
    });
    await createMemory(db, {
      entity_id: seed.entityId,
      agent_id: seed.agentId,
      fact: 'unrelated billing preferences note',
      category: 'context',
      importance: 5,
      source: 'agent',
      skill_tags: [],
    });

    // No single memory contains ALL the query words → plainto(AND) would match
    // nothing and fall back to importance (the off-topic importance-5 note first).
    // OR must surface the on-topic memory despite its lower importance.
    const out = await selectMemoriesForInjection(db, {
      entityId: seed.entityId,
      maxChars: 5000,
      query: 'generate comfyui image woman photorealistic',
    });
    expect(out[0]?.id).toBe(onTopic.id);
  });
});
