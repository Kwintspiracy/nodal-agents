// @nodal-agents/memory — shared types for higher-level memory operations

import type { MemoryCategory } from '@nodal-agents/shared';

// ─── Search ────────────────────────────────────────────────────────────────────

export interface SearchOptions {
  query: string;
  /** Scope to a single agent. Omit for entity-wide search. */
  agentId?: string;
  /** Required — every query must be scoped to an entity. */
  entityId: string;
  /**
   * Skill-filter: restrict to memories whose skill_tags intersect this array.
   * Empty array or undefined → no filter applied (return all).
   * Memories with empty skill_tags on the row itself are ALWAYS returned (uncategorized).
   */
  skillTags?: string[];
  category?: MemoryCategory;
  /** Default: 10 */
  limit?: number;
  /**
   * Cosine-similarity threshold for vector search.
   * Default: 0.5. Ignored when embedding provider returns null.
   */
  similarityThreshold?: number;
}

export type KeywordSort = 'importance' | 'recent';

/**
 * Options for keywordSearchMemories — the embedding-free keyword search exposed
 * to the query_memory tool. Same scoping semantics as SearchOptions.
 */
export interface KeywordSearchOptions {
  query: string;
  entityId: string;
  agentId?: string;
  skillTags?: string[];
  category?: MemoryCategory;
  /** Default: 10 */
  limit?: number;
  /** Default: 'importance' */
  sort?: KeywordSort;
  /**
   * Whether returned rows bump access_count/last_accessed_at (the usage
   * signal the curator re-scores importance from). Default: true — real
   * agent usage (the query_memory tool) should count. Set false for
   * read-only UI search (e.g. the /memories page search box) so browsing
   * doesn't inflate a fact's proven-usage signal.
   */
  touch?: boolean;
}

// ─── List / Pagination ─────────────────────────────────────────────────────────

export type MemorySortField = 'recent' | 'importance' | 'last_accessed';

export interface ListOptions {
  entityId: string;
  agentId?: string;
  category?: MemoryCategory;
  /** OR filter: any memory whose skill_tags overlaps this set is returned. */
  tags?: string[];
  /** Default: false */
  archived?: boolean;
  /** 1-indexed. Values ≤ 0 are treated as 1. Default: 1 */
  page?: number;
  /** Default: 50. Clamped to max 200. */
  pageSize?: number;
  /** Default: 'recent' */
  sort?: MemorySortField;
}

export interface PagedResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  totalCount: number;
  hasMore: boolean;
}

// ─── Stats ─────────────────────────────────────────────────────────────────────

export interface MemoryStats {
  totalCount: number;
  countByCategory: Record<MemoryCategory, number>;
  countByTag: Array<{ tag: string; count: number }>;
  lastAccessAt: string | null;
  averageImportance: number;
}
