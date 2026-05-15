// @nodal-agents/memory — one-shot embedding backfill
//
// Memories written before embedding generation existed (or while the embedding
// provider was unavailable) have a NULL embedding column. searchMemories still
// finds them via the keyword fallback, but they can't participate in semantic
// vector search until backfilled. This function is idempotent: it only touches
// rows where embedding IS NULL, so it is safe to re-run.

import { eq, isNull } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { agentMemory } from '@nodal-agents/db';
import type { EmbeddingClient } from '@nodal-agents/llm';

export interface BackfillResult {
  /** Rows that had no embedding at the start of the run. */
  candidates: number;
  /** Rows successfully given an embedding this run. */
  embedded: number;
}

/**
 * Generate embeddings for every memory row that lacks one. Idempotent — re-runs
 * only process rows still missing an embedding. A per-row embedding failure is
 * skipped (left NULL) so the next run can retry it; it never aborts the batch.
 */
export async function backfillEmbeddings(
  db: AnyDrizzleDb,
  embeddingClient: EmbeddingClient,
): Promise<BackfillResult> {
  const rows = await db
    .select({ id: agentMemory.id, fact: agentMemory.fact })
    .from(agentMemory)
    .where(isNull(agentMemory.embedding));

  let embedded = 0;
  for (const row of rows) {
    let embedding: number[] | null = null;
    try {
      embedding = await embeddingClient.embed(row.fact);
    } catch {
      embedding = null;
    }
    if (embedding) {
      await db.update(agentMemory).set({ embedding }).where(eq(agentMemory.id, row.id));
      embedded += 1;
    }
  }

  return { candidates: rows.length, embedded };
}
