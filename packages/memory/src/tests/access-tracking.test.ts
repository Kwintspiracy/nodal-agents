// access-tracking.test.ts — touchMemory bumps access_count + last_accessed_at

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodalai/db/test-utils';
import { createMemory, getMemory } from '../crud';
import { touchMemory, touchMemories } from '../access-tracking';

let db: Awaited<ReturnType<typeof spinUpTestDb>>['db'];
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
});

describe('touchMemory', () => {
  it('increments access_count from 0 to 1', async () => {
    const created = await createMemory(db, {
      entity_id: seed.entityId,
      fact: 'Touch me once.',
      category: 'context',
      importance: 3,
      source: 'agent',
      skill_tags: [],
    });

    expect(created.access_count).toBe(0);

    await touchMemory(db, created.id, seed.entityId);

    const fetched = await getMemory(db, created.id, seed.entityId);
    expect(fetched.access_count).toBe(1);
  });

  it('increments access_count multiple times', async () => {
    const created = await createMemory(db, {
      entity_id: seed.entityId,
      fact: 'Touch me three times.',
      category: 'context',
      importance: 3,
      source: 'agent',
      skill_tags: [],
    });

    await touchMemory(db, created.id, seed.entityId);
    await touchMemory(db, created.id, seed.entityId);
    await touchMemory(db, created.id, seed.entityId);

    const fetched = await getMemory(db, created.id, seed.entityId);
    expect(fetched.access_count).toBe(3);
  });

  it('updates last_accessed_at', async () => {
    const created = await createMemory(db, {
      entity_id: seed.entityId,
      fact: 'Track access time.',
      category: 'context',
      importance: 3,
      source: 'agent',
      skill_tags: [],
    });

    const before = new Date();
    await touchMemory(db, created.id, seed.entityId);
    const after = new Date();

    const fetched = await getMemory(db, created.id, seed.entityId);
    if (fetched.last_accessed_at) {
      const accessedAt = new Date(fetched.last_accessed_at);
      expect(accessedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
      expect(accessedAt.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
    }
  });

  it('is a no-op for unknown memory id (no throw)', async () => {
    await expect(touchMemory(db, crypto.randomUUID(), seed.entityId)).resolves.not.toThrow();
  });
});

describe('touchMemories', () => {
  it('handles empty ids array without error', async () => {
    await expect(touchMemories(db, [], seed.entityId)).resolves.not.toThrow();
  });

  it('bumps access_count for multiple memories', async () => {
    const m1 = await createMemory(db, {
      entity_id: seed.entityId,
      fact: 'Batch touch 1.',
      category: 'context',
      importance: 3,
      source: 'agent',
      skill_tags: [],
    });
    const m2 = await createMemory(db, {
      entity_id: seed.entityId,
      fact: 'Batch touch 2.',
      category: 'context',
      importance: 3,
      source: 'agent',
      skill_tags: [],
    });

    await touchMemories(db, [m1.id, m2.id], seed.entityId);

    const f1 = await getMemory(db, m1.id, seed.entityId);
    const f2 = await getMemory(db, m2.id, seed.entityId);

    expect(f1.access_count).toBe(1);
    expect(f2.access_count).toBe(1);
  });
});
