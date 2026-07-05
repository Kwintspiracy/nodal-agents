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

/** Rows processed between pauses — keeps a large backlog from hogging the
 * event loop / DB connection in one uninterrupted burst (finding M-17). */
const BATCH_SIZE = 25;
/** Pause between batches, ms. Small — this only yields, it doesn't throttle. */
const BATCH_PAUSE_MS = 50;

/**
 * Generate embeddings for every memory row that lacks one. Idempotent — re-runs
 * only process rows still missing an embedding. A per-row failure — EITHER the
 * embed() call or the write that persists it — is caught and skipped (left
 * NULL) so the next run can retry it; it never aborts the batch. Finding M-17:
 * previously only embed() was guarded and the `UPDATE` sat outside the
 * try/catch, so a single write failure (e.g. a transient DB hiccup) would
 * throw uncaught and abort every row still queued behind it.
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
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    try {
      const embedding = await embeddingClient.embed(row.fact);
      if (embedding) {
        await db.update(agentMemory).set({ embedding }).where(eq(agentMemory.id, row.id));
        embedded += 1;
      }
    } catch (err) {
      console.warn(`[memory] backfill: row ${row.id} failed (will retry next run):`, err);
    }

    if ((i + 1) % BATCH_SIZE === 0 && i + 1 < rows.length) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_PAUSE_MS));
    }
  }

  return { candidates: rows.length, embedded };
}
