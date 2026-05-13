// stats.test.ts — accurate counts, category breakdown, tag counts

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import { createMemory } from '../crud';
import { getMemoryStats } from '../stats';

let db: Awaited<ReturnType<typeof spinUpTestDb>>['db'];
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
// Isolated entity with known exact counts
let statsEntityId: string;

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);

  // Create isolated entity for deterministic stats
  const { entities } = await import('@nodal-agents/db');
  const [entity] = await db
    .insert(entities)
    .values({
      userId: seed.userId,
      name: 'Stats Entity',
      slug: `stats-entity-${Date.now()}`,
    })
    .returning();
  if (!entity) throw new Error('failed to create stats entity');
  statsEntityId = entity.id;

  // Insert 7 memories with known distribution
  await createMemory(db, {
    entity_id: statsEntityId,
    fact: 'Pref 1',
    category: 'preference',
    importance: 5,
    source: 'manual',
    skill_tags: ['gmail'],
  });
  await createMemory(db, {
    entity_id: statsEntityId,
    fact: 'Pref 2',
    category: 'preference',
    importance: 4,
    source: 'manual',
    skill_tags: ['gmail'],
  });
  await createMemory(db, {
    entity_id: statsEntityId,
    fact: 'Context 1',
    category: 'context',
    importance: 3,
    source: 'agent',
    skill_tags: ['notion'],
  });
  await createMemory(db, {
    entity_id: statsEntityId,
    fact: 'Context 2',
    category: 'context',
    importance: 2,
    source: 'agent',
    skill_tags: [],
  });
  await createMemory(db, {
    entity_id: statsEntityId,
    fact: 'Outcome 1',
    category: 'outcome',
    importance: 3,
    source: 'reflection',
    skill_tags: ['gmail', 'notion'],
  });
  await createMemory(db, {
    entity_id: statsEntityId,
    fact: 'Rule 1',
    category: 'learned_rule',
    importance: 5,
    source: 'reflection',
    skill_tags: [],
  });
  await createMemory(db, {
    entity_id: statsEntityId,
    fact: 'Rule 2',
    category: 'learned_rule',
    importance: 4,
    source: 'reflection',
    skill_tags: ['gmail'],
  });
});

describe('getMemoryStats', () => {
  it('returns correct totalCount', async () => {
    const stats = await getMemoryStats(db, { entityId: statsEntityId });
    expect(stats.totalCount).toBe(7);
  });

  it('returns correct countByCategory', async () => {
    const stats = await getMemoryStats(db, { entityId: statsEntityId });

    expect(stats.countByCategory.preference).toBe(2);
    expect(stats.countByCategory.context).toBe(2);
    expect(stats.countByCategory.outcome).toBe(1);
    expect(stats.countByCategory.learned_rule).toBe(2);
  });

  it('all categories present in countByCategory (even zeros)', async () => {
    // Create entity with only one category
    const { entities } = await import('@nodal-agents/db');
    const [entity] = await db
      .insert(entities)
      .values({
        userId: seed.userId,
        name: `Sparse ${Date.now()}`,
        slug: `sparse-${Date.now()}`,
      })
      .returning();
    if (!entity) throw new Error('failed');

    await createMemory(db, {
      entity_id: entity.id,
      fact: 'Only pref.',
      category: 'preference',
      importance: 3,
      source: 'manual',
      skill_tags: [],
    });

    const stats = await getMemoryStats(db, { entityId: entity.id });

    // Should have all categories with 0 for missing ones
    expect(stats.countByCategory.preference).toBe(1);
    expect(stats.countByCategory.context).toBe(0);
    expect(stats.countByCategory.outcome).toBe(0);
    expect(stats.countByCategory.learned_rule).toBe(0);
  });

  it('returns correct countByTag with accurate counts', async () => {
    const stats = await getMemoryStats(db, { entityId: statsEntityId });

    // Expected: gmail=3 (pref1, pref2, outcome1, rule2 = 4), notion=2 (context1, outcome1)
    // Wait: pref1 has gmail, pref2 has gmail, outcome1 has gmail+notion, rule2 has gmail
    // So gmail appears in 4 memories, notion in 2

    const gmailEntry = stats.countByTag.find((e) => e.tag === 'gmail');
    const notionEntry = stats.countByTag.find((e) => e.tag === 'notion');

    expect(gmailEntry).toBeDefined();
    expect(gmailEntry!.count).toBe(4);
    expect(notionEntry).toBeDefined();
    expect(notionEntry!.count).toBe(2);
  });

  it('returns countByTag sorted by count descending', async () => {
    const stats = await getMemoryStats(db, { entityId: statsEntityId });

    const counts = stats.countByTag.map((e) => e.count);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i - 1]!).toBeGreaterThanOrEqual(counts[i]!);
    }
  });

  it('returns averageImportance correctly', async () => {
    const stats = await getMemoryStats(db, { entityId: statsEntityId });

    // Importances: 5, 4, 3, 2, 3, 5, 4 → sum=26, avg=26/7 ≈ 3.71
    const expected = 26 / 7;
    expect(stats.averageImportance).toBeCloseTo(expected, 1);
  });

  it('scopes to agentId when provided', async () => {
    await createMemory(db, {
      entity_id: statsEntityId,
      agent_id: seed.agentId,
      fact: 'Agent-scoped for stats.',
      category: 'context',
      importance: 3,
      source: 'agent',
      skill_tags: [],
    });

    const agentStats = await getMemoryStats(db, {
      entityId: statsEntityId,
      agentId: seed.agentId,
    });

    // Only 1 memory belongs to this agent in this entity
    expect(agentStats.totalCount).toBe(1);
  });

  it('returns totalCount 0 and empty arrays for entity with no memories', async () => {
    const { entities } = await import('@nodal-agents/db');
    const [entity] = await db
      .insert(entities)
      .values({
        userId: seed.userId,
        name: `Empty Stats ${Date.now()}`,
        slug: `empty-stats-${Date.now()}`,
      })
      .returning();
    if (!entity) throw new Error('failed');

    const stats = await getMemoryStats(db, { entityId: entity.id });

    expect(stats.totalCount).toBe(0);
    expect(stats.countByTag).toHaveLength(0);
    expect(stats.lastAccessAt).toBeNull();
    expect(stats.averageImportance).toBe(0);
  });
});
