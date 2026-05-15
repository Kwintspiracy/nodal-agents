// @nodal-agents/memory — public API

// Types
export type {
  SearchOptions,
  KeywordSearchOptions,
  KeywordSort,
  ListOptions,
  PagedResult,
  MemoryStats,
  MemorySortField,
} from './types';

// Errors
export {
  MemoryError,
  MemoryNotFoundError,
  MemorySanitationError,
  MemoryDuplicateError,
} from './errors';
export type { MemoryErrorCode } from './errors';

// CRUD
export { getMemory, createMemory, updateMemory, deleteMemory, rowToMemory } from './crud';
export type { MemoryRow } from './crud';

// Sanitation + hashing (pure)
export { sanitizeMemoryContent, MAX_FACT_LENGTH } from './sanitize';
export { computeFactHash, normalizeFact } from './hash';

// List
export { listMemories } from './list';

// Search
export { searchMemories, keywordSearchMemories } from './search';

// Embedding backfill (one-shot, idempotent)
export { backfillEmbeddings } from './backfill';
export type { BackfillResult } from './backfill';

// Filter (pure functions)
export { applySkillFilter, filterByTags } from './filter';

// System-prompt injection (Sprint 2 — auto-injection)
export { selectMemoriesUnderBudget, selectMemoriesForInjection } from './inject';

// Find-by-substring (Sprint 2 — feedback-loop tools dispatch on result count)
export { findMemoriesByFactSubstring } from './find';

// Stats
export { getMemoryStats } from './stats';

// Access tracking
export { touchMemory, touchMemories } from './access-tracking';
