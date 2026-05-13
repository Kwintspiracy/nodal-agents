// crud.test.ts — createMemory, getMemory, updateMemory, deleteMemory

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import { createMemory, getMemory, updateMemory, deleteMemory } from '../crud';
import { MemoryNotFoundError } from '../errors';

let db: Awaited<ReturnType<typeof spinUpTestDb>>['db'];
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
});

describe('createMemory', () => {
  it('inserts a new memory and returns it with generated id', async () => {
    const memory = await createMemory(db, {
      entity_id: seed.entityId,
      fact: 'User prefers concise answers.',
      category: 'preference',
      importance: 4,
      source: 'manual',
      skill_tags: [],
    });

    expect(memory.id).toBeTruthy();
    expect(memory.entity_id).toBe(seed.entityId);
    expect(memory.fact).toBe('User prefers concise answers.');
    expect(memory.category).toBe('preference');
    expect(memory.importance).toBe(4);
    expect(memory.archived).toBe(false);
    expect(memory.access_count).toBe(0);
  });

  it('stores skill_tags correctly', async () => {
    const memory = await createMemory(db, {
      entity_id: seed.entityId,
      fact: 'Gmail API requires OAuth2.',
      category: 'context',
      importance: 3,
      source: 'agent',
      skill_tags: ['gmail', 'oauth'],
    });

    expect(memory.skill_tags).toEqual(['gmail', 'oauth']);
  });

  it('creates with explicit defaults, stored correctly', async () => {
    const memory = await createMemory(db, {
      entity_id: seed.entityId,
      fact: 'Minimal memory entry.',
      category: 'context',
      importance: 3,
      source: 'manual',
      skill_tags: [],
    });

    expect(memory.category).toBe('context');
    expect(memory.importance).toBe(3);
    expect(memory.source).toBe('manual');
    expect(memory.skill_tags).toEqual([]);
  });

  it('scopes to agent when agent_id provided', async () => {
    const memory = await createMemory(db, {
      entity_id: seed.entityId,
      agent_id: seed.agentId,
      fact: 'Agent-scoped memory.',
      category: 'learned_rule',
      importance: 5,
      source: 'agent',
      skill_tags: [],
    });

    expect(memory.agent_id).toBe(seed.agentId);
  });
});

describe('getMemory', () => {
  it('retrieves a memory by id + entityId', async () => {
    const created = await createMemory(db, {
      entity_id: seed.entityId,
      fact: 'Fact for get test.',
      category: 'context',
      importance: 3,
      source: 'agent',
      skill_tags: [],
    });

    // Read back the actual DB row
    const fetched = await getMemory(db, created.id, seed.entityId);

    expect(fetched.id).toBe(created.id);
    expect(fetched.fact).toBe('Fact for get test.');
    expect(fetched.entity_id).toBe(seed.entityId);
  });

  it('throws MemoryNotFoundError for unknown id', async () => {
    await expect(getMemory(db, crypto.randomUUID(), seed.entityId)).rejects.toThrow(
      MemoryNotFoundError,
    );
  });

  it('throws MemoryNotFoundError when entityId does not match', async () => {
    const created = await createMemory(db, {
      entity_id: seed.entityId,
      fact: 'Cross-entity check.',
      category: 'context',
      importance: 3,
      source: 'agent',
      skill_tags: [],
    });

    // Wrong entityId — entity isolation must hold
    await expect(getMemory(db, created.id, crypto.randomUUID())).rejects.toThrow(
      MemoryNotFoundError,
    );
  });
});

describe('updateMemory', () => {
  it('updates fact and importance, reads back correct values', async () => {
    const created = await createMemory(db, {
      entity_id: seed.entityId,
      fact: 'Original fact.',
      category: 'context',
      importance: 2,
      source: 'agent',
      skill_tags: [],
    });

    const updated = await updateMemory(db, created.id, seed.entityId, {
      fact: 'Updated fact.',
      importance: 5,
    });

    expect(updated.fact).toBe('Updated fact.');
    expect(updated.importance).toBe(5);
    expect(updated.id).toBe(created.id);

    // Verify the update persisted in DB
    const fetched = await getMemory(db, created.id, seed.entityId);
    expect(fetched.fact).toBe('Updated fact.');
    expect(fetched.importance).toBe(5);
  });

  it('updates skill_tags array', async () => {
    const created = await createMemory(db, {
      entity_id: seed.entityId,
      fact: 'Tag update test.',
      category: 'context',
      importance: 3,
      source: 'agent',
      skill_tags: ['notion'],
    });

    const updated = await updateMemory(db, created.id, seed.entityId, {
      skill_tags: ['notion', 'drive'],
    });

    expect(updated.skill_tags).toEqual(['notion', 'drive']);
  });

  it('throws MemoryNotFoundError for unknown id', async () => {
    await expect(
      updateMemory(db, crypto.randomUUID(), seed.entityId, { fact: 'x' }),
    ).rejects.toThrow(MemoryNotFoundError);
  });

  it('can archive a memory', async () => {
    const created = await createMemory(db, {
      entity_id: seed.entityId,
      fact: 'To be archived.',
      category: 'outcome',
      importance: 3,
      source: 'agent',
      skill_tags: [],
    });

    const archived = await updateMemory(db, created.id, seed.entityId, {
      archived: true,
    });

    expect(archived.archived).toBe(true);
  });
});

describe('deleteMemory', () => {
  it('removes the memory from DB', async () => {
    const created = await createMemory(db, {
      entity_id: seed.entityId,
      fact: 'To be deleted.',
      category: 'context',
      importance: 1,
      source: 'agent',
      skill_tags: [],
    });

    await deleteMemory(db, created.id, seed.entityId);

    // Confirm it's gone
    await expect(getMemory(db, created.id, seed.entityId)).rejects.toThrow(MemoryNotFoundError);
  });

  it('throws MemoryNotFoundError when memory does not exist', async () => {
    await expect(deleteMemory(db, crypto.randomUUID(), seed.entityId)).rejects.toThrow(
      MemoryNotFoundError,
    );
  });
});
