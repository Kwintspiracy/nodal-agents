// @nodalai/memory — shared types for higher-level memory operations

import type { MemoryCategory } from '@nodalai/shared';

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
