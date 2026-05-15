// backfill.test.ts — backfillEmbeddings: fills NULL embeddings, idempotent

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import { agentMemory, eq } from '@nodal-agents/db';
import type { EmbeddingClient } from '@nodal-agents/llm';
import { createMemory } from '../crud';
import { backfillEmbeddings } from '../backfill';

let db: Awaited<ReturnType<typeof spinUpTestDb>>['db'];
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

const fakeEmbeddingClient: EmbeddingClient = {
  embed: async (text: string) =>
    Array.from({ length: 1536 }, (_, i) => ((text.charCodeAt(i % text.length) + i) % 100) / 100),
  dimensions: 1536,
};

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
});

describe('backfillEmbeddings', () => {
  it('fills embeddings for rows that have none', async () => {
    // Two memories created WITHOUT an embedding client → embedding IS NULL
    const a = await createMemory(db, {
      entity_id: seed.entityId,
      fact: 'Backfill candidate one.',
      category: 'context',
      importance: 3,
      source: 'agent',
      skill_tags: [],
    });
    const b = await createMemory(db, {
      entity_id: seed.entityId,
      fact: 'Backfill candidate two.',
      category: 'context',
      importance: 3,
      source: 'agent',
      skill_tags: [],
    });

    const result = await backfillEmbeddings(db, fakeEmbeddingClient);

    expect(result.candidates).toBeGreaterThanOrEqual(2);
    expect(result.embedded).toBe(result.candidates);

    for (const id of [a.id, b.id]) {
      const rows = await db.select().from(agentMemory).where(eq(agentMemory.id, id));
      expect(rows[0]?.embedding).not.toBeNull();
      expect(rows[0]?.embedding).toHaveLength(1536);
    }
  });

  it('is idempotent — a second run finds no candidates', async () => {
    const second = await backfillEmbeddings(db, fakeEmbeddingClient);
    expect(second.candidates).toBe(0);
    expect(second.embedded).toBe(0);
  });

  it('does not overwrite an embedding that already exists', async () => {
    const withEmbedding = await createMemory(
      db,
      {
        entity_id: seed.entityId,
        fact: 'This row already has an embedding.',
        category: 'context',
        importance: 3,
        source: 'agent',
        skill_tags: [],
      },
      fakeEmbeddingClient,
    );

    const before = await db.select().from(agentMemory).where(eq(agentMemory.id, withEmbedding.id));
    const result = await backfillEmbeddings(db, fakeEmbeddingClient);
    const after = await db.select().from(agentMemory).where(eq(agentMemory.id, withEmbedding.id));

    expect(result.candidates).toBe(0);
    expect(after[0]?.embedding).toEqual(before[0]?.embedding);
  });
});
