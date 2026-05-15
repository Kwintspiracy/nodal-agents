// backfill-embeddings.test.ts — Memory Sprint 1 (item 1.3b) boot step
//
// Verifies that on runner boot, agent_memory rows with a NULL embedding get one
// generated. Rows that already have an embedding are left untouched (re-running
// is a no-op). The NULL-embedding precondition is produced the real way — via
// createMemory called without an embedding client — never a direct INSERT.

import { describe, it, expect } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import { agentMemory, eq } from '@nodal-agents/db';
import { createMemory } from '@nodal-agents/memory';
import type { EmbeddingClient } from '@nodal-agents/llm';
import { backfillMemoryEmbeddings } from '../../bootstrap/backfill-embeddings.ts';

// Deterministic 1536-dim embedding — enough to assert the column got populated.
const fakeEmbeddingClient: EmbeddingClient = {
  embed: async (text: string) =>
    Array.from({ length: 1536 }, (_, i) => ((text.charCodeAt(i % text.length) + i) % 100) / 100),
  dimensions: 1536,
};

describe('backfillMemoryEmbeddings (Sprint 1 boot step)', () => {
  it('generates embeddings for rows that have none', async () => {
    const { db } = await spinUpTestDb();
    const seed = await seedMinimal(db);

    // createMemory without an embedding client → embedding column IS NULL.
    const m = await createMemory(db, {
      entity_id: seed.entityId,
      fact: 'Runner boot backfill candidate.',
      category: 'context',
      importance: 3,
      source: 'agent',
      skill_tags: [],
    });

    const [before] = await db.select().from(agentMemory).where(eq(agentMemory.id, m.id));
    expect(before?.embedding).toBeNull();

    await backfillMemoryEmbeddings(db, fakeEmbeddingClient);

    const [after] = await db.select().from(agentMemory).where(eq(agentMemory.id, m.id));
    expect(after?.embedding).not.toBeNull();
    expect(after?.embedding).toHaveLength(1536);
  });

  it('is idempotent: a second boot leaves already-embedded rows untouched', async () => {
    const { db } = await spinUpTestDb();
    const seed = await seedMinimal(db);

    const m = await createMemory(db, {
      entity_id: seed.entityId,
      fact: 'Idempotent backfill probe.',
      category: 'context',
      importance: 3,
      source: 'agent',
      skill_tags: [],
    });

    await backfillMemoryEmbeddings(db, fakeEmbeddingClient);
    const [afterFirst] = await db.select().from(agentMemory).where(eq(agentMemory.id, m.id));

    await backfillMemoryEmbeddings(db, fakeEmbeddingClient);
    const [afterSecond] = await db.select().from(agentMemory).where(eq(agentMemory.id, m.id));

    expect(afterSecond?.embedding).toEqual(afterFirst?.embedding);
  });
});
