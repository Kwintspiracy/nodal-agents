// bootstrap/backfill-embeddings.ts — Memory Sprint 1 (item 1.3b)
//
// One-shot, idempotent backfill that generates embeddings for agent_memory rows
// written before embedding generation existed (or while the embedding provider
// was unavailable) — their `embedding` column is NULL.
//
// Runs on every runner boot. Rows that already have an embedding are skipped, so
// re-running is a no-op. The first run after deploying Sprint 1 picks up legacy
// rows; from then on createMemory writes embeddings inline, so this is normally
// a zero-row pass. Search still finds un-backfilled rows via the keyword
// fallback, so a failed/partial run never makes memories unreachable.

import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { EmbeddingClient } from '@nodal-agents/llm';
import { backfillEmbeddings } from '@nodal-agents/memory';

export async function backfillMemoryEmbeddings(
  db: AnyDrizzleDb,
  embeddingClient: EmbeddingClient,
): Promise<void> {
  const { candidates, embedded } = await backfillEmbeddings(db, embeddingClient);
  if (candidates > 0) {
    console.warn(
      `[memory] backfilled embeddings for ${embedded}/${candidates} memory row(s) missing one`,
    );
  }
}
