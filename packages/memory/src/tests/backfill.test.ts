// backfill.test.ts — backfillEmbeddings: fills NULL embeddings, idempotent

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import { agentMemory, eq } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
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

  // Finding M-17: the write (db.update) that persists a computed embedding was
  // OUTSIDE the per-row try/catch — only the embed() call was guarded. A single
  // write failure (transient DB hiccup, connection blip) would throw uncaught
  // and abort the whole batch, leaving every row still queued behind it un-
  // touched even though their embed() calls would have succeeded fine.
  it('a write failure on one row does not abort the batch — other rows still get embedded', async () => {
    const a = await createMemory(db, {
      entity_id: seed.entityId,
      fact: 'Row whose write will fail.',
      category: 'context',
      importance: 3,
      source: 'agent',
      skill_tags: [],
    });
    const b = await createMemory(db, {
      entity_id: seed.entityId,
      fact: 'Row whose write should still succeed.',
      category: 'context',
      importance: 3,
      source: 'agent',
      skill_tags: [],
    });

    // Wrap the real db so the FIRST db.update(...) call throws (simulating a
    // write failure on the first candidate row), while every other call
    // (select, and subsequent updates) passes through to the real db
    // unchanged. select/update are prototype methods on the drizzle instance,
    // not own properties, so a Proxy forwarding via Reflect.get is used
    // instead of an object-spread copy (which would silently drop them).
    let updateCallCount = 0;
    const failingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'update') {
          updateCallCount++;
          if (updateCallCount === 1) {
            return () => ({
              set: () => ({
                where: async () => {
                  throw new Error('simulated write failure');
                },
              }),
            });
          }
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as AnyDrizzleDb;

    const result = await backfillEmbeddings(failingDb, fakeEmbeddingClient);

    // Both rows were candidates; exactly one write failed (the first update
    // call, whichever row that lands on — select has no ORDER BY, so don't
    // assume which of a/b it is), the other succeeded despite it.
    expect(result.candidates).toBe(2);
    expect(result.embedded).toBe(1);

    const rowA = await db.select().from(agentMemory).where(eq(agentMemory.id, a.id));
    const rowB = await db.select().from(agentMemory).where(eq(agentMemory.id, b.id));
    const embeddings = [rowA[0]?.embedding ?? null, rowB[0]?.embedding ?? null];
    // Exactly one row failed (left NULL, retryable) and one succeeded — the
    // failure never aborted the other row's write.
    expect(embeddings.filter((e) => e === null)).toHaveLength(1);
    expect(embeddings.filter((e) => e !== null)).toHaveLength(1);

    // A subsequent (real) run picks up exactly the still-NULL row.
    const retry = await backfillEmbeddings(db, fakeEmbeddingClient);
    expect(retry.candidates).toBe(1);
    expect(retry.embedded).toBe(1);
  });
});
