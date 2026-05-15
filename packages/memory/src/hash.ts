// @nodal-agents/memory — content hashing for deduplication
//
// fact_hash lets createMemory reject an identical fact before it pollutes the
// store (an agent stuck in a loop would otherwise insert "user is Quentin" 50×).
// The column and idx_agent_memory_fact_hash already exist in the schema.

import { createHash } from 'node:crypto';

/**
 * Normalize a fact for hashing: lowercase, trim, collapse internal whitespace.
 * Two facts that differ only in casing or spacing produce the same hash.
 */
export function normalizeFact(fact: string): string {
  return fact.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Deterministic SHA-256 of the normalized fact. Used as the dedup key, scoped
 * per entity at the query level (entity_id + fact_hash + archived = false).
 */
export function computeFactHash(fact: string): string {
  return createHash('sha256').update(normalizeFact(fact)).digest('hex');
}
