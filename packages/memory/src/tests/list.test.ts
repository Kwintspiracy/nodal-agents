// list.test.ts — pagination edge cases + filter combinators

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import { createMemory } from '../crud';
import { listMemories } from '../list';
import { MemoryError } from '../errors';

let db: Awaited<ReturnType<typeof spinUpTestDb>>['db'];
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);

  // Insert a batch of 15 memories for pagination tests
  for (let i = 1; i <= 15; i++) {
    await createMemory(db, {
      entity_id: seed.entityId,
      fact: `Pagination test memory ${i}`,
      category: i % 2 === 0 ? 'preference' : 'context',
      importance: (i % 5) + 1,
      source: 'manual',
      skill_tags: i % 3 === 0 ? ['gmail'] : [],
    });
  }
});

describe('listMemories — pagination', () => {
  it('returns first page with correct pageSize', async () => {
    const result = await listMemories(db, {
      entityId: seed.entityId,
      page: 1,
      pageSize: 5,
    });

    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(5);
    expect(result.items).toHaveLength(5);
    expect(result.totalCount).toBeGreaterThanOrEqual(15);
    expect(result.hasMore).toBe(true);
  });

  it('returns correct items on page 2', async () => {
    const page1 = await listMemories(db, { entityId: seed.entityId, page: 1, pageSize: 5 });
    const page2 = await listMemories(db, { entityId: seed.entityId, page: 2, pageSize: 5 });

    const page1Ids = new Set(page1.items.map((m) => m.id));
    // Page 2 items should not overlap with page 1
    for (const item of page2.items) {
      expect(page1Ids.has(item.id)).toBe(false);
    }
  });

  it('returns empty items when page is beyond data', async () => {
    const result = await listMemories(db, {
      entityId: seed.entityId,
      page: 9999,
      pageSize: 50,
    });

    expect(result.items).toHaveLength(0);
    expect(result.hasMore).toBe(false);
    expect(result.totalCount).toBeGreaterThan(0);
  });

  it('treats page <= 0 as page 1', async () => {
    const resultPage0 = await listMemories(db, { entityId: seed.entityId, page: 0, pageSize: 5 });
    const resultPage1 = await listMemories(db, { entityId: seed.entityId, page: 1, pageSize: 5 });

    expect(resultPage0.page).toBe(1);
    expect(resultPage0.items.map((m) => m.id)).toEqual(resultPage1.items.map((m) => m.id));
  });

  it('treats negative page as page 1', async () => {
    const result = await listMemories(db, { entityId: seed.entityId, page: -5, pageSize: 5 });
    expect(result.page).toBe(1);
  });

  it('clamps pageSize > 200 to 200', async () => {
    const result = await listMemories(db, {
      entityId: seed.entityId,
      pageSize: 999,
    });

    expect(result.pageSize).toBe(200);
  });

  it('returns empty result set for entity with no memories', async () => {
    // Create a new entity with no memories
    const { entityId: emptyEntityId } = await createIsolatedEntity(db, seed.userId);

    const result = await listMemories(db, { entityId: emptyEntityId });

    expect(result.items).toHaveLength(0);
    expect(result.totalCount).toBe(0);
    expect(result.hasMore).toBe(false);
  });

  it('throws MemoryError when entityId is missing', async () => {
    await expect(listMemories(db, { entityId: '' })).rejects.toThrow(MemoryError);
  });
});

describe('listMemories — filter combinators', () => {
  it('filters by category', async () => {
    const result = await listMemories(db, {
      entityId: seed.entityId,
      category: 'preference',
      pageSize: 50,
    });

    for (const item of result.items) {
      expect(item.category).toBe('preference');
    }
  });

  it('filters by agentId', async () => {
    // Insert memory scoped to agent
    await createMemory(db, {
      entity_id: seed.entityId,
      agent_id: seed.agentId,
      fact: 'Agent-specific memory for list test.',
      category: 'context',
      importance: 3,
      source: 'agent',
      skill_tags: [],
    });

    const result = await listMemories(db, {
      entityId: seed.entityId,
      agentId: seed.agentId,
    });

    for (const item of result.items) {
      expect(item.agent_id).toBe(seed.agentId);
    }
    expect(result.items.length).toBeGreaterThanOrEqual(1);
  });

  it('filters by tags (OR semantics)', async () => {
    // Insert some tagged memories
    await createMemory(db, {
      entity_id: seed.entityId,
      fact: 'Drive memory for tag filter.',
      category: 'context',
      importance: 3,
      source: 'agent',
      skill_tags: ['drive'],
    });

    const result = await listMemories(db, {
      entityId: seed.entityId,
      tags: ['drive'],
      pageSize: 50,
    });

    for (const item of result.items) {
      expect(item.skill_tags).toContain('drive');
    }
  });

  it('default sort is recent (updated_at DESC)', async () => {
    const result = await listMemories(db, {
      entityId: seed.entityId,
      pageSize: 10,
      sort: 'recent',
    });

    const dates = result.items.map((m) => new Date(m.updated_at).getTime());
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i - 1]!).toBeGreaterThanOrEqual(dates[i]!);
    }
  });

  it('sort by importance returns higher importance first', async () => {
    const result = await listMemories(db, {
      entityId: seed.entityId,
      pageSize: 15,
      sort: 'importance',
    });

    const importances = result.items.map((m) => m.importance);
    for (let i = 1; i < importances.length; i++) {
      expect(importances[i - 1]!).toBeGreaterThanOrEqual(importances[i]!);
    }
  });

  it('does not return archived memories by default', async () => {
    // Create then archive a memory
    const created = await createMemory(db, {
      entity_id: seed.entityId,
      fact: 'This will be archived.',
      category: 'context',
      importance: 3,
      source: 'agent',
      skill_tags: [],
    });

    // Archive it directly
    const { agentMemory } = await import('@nodal-agents/db');
    const { eq } = await import('@nodal-agents/db');
    await db.update(agentMemory).set({ archived: true }).where(eq(agentMemory.id, created.id));

    const result = await listMemories(db, {
      entityId: seed.entityId,
      pageSize: 200,
    });

    const ids = result.items.map((m) => m.id);
    expect(ids).not.toContain(created.id);
  });
});

// ─── Helper ────────────────────────────────────────────────────────────────────

async function createIsolatedEntity(
  dbInstance: typeof db,
  userId: string,
): Promise<{ entityId: string }> {
  const { entities } = await import('@nodal-agents/db');
  const [entity] = await dbInstance
    .insert(entities)
    .values({
      userId,
      name: `Isolated ${Date.now()}`,
      slug: `isolated-${Date.now()}`,
    })
    .returning();
  if (!entity) throw new Error('failed to create isolated entity');
  return { entityId: entity.id };
}
