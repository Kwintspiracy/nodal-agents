// @nodalai/memory — public API

// Types
export type {
  SearchOptions,
  ListOptions,
  PagedResult,
  MemoryStats,
  MemorySortField,
} from './types.js';

// Errors
export { MemoryError, MemoryNotFoundError } from './errors.js';
export type { MemoryErrorCode } from './errors.js';

// CRUD
export { getMemory, createMemory, updateMemory, deleteMemory, rowToMemory } from './crud.js';
export type { MemoryRow } from './crud.js';

// List
export { listMemories } from './list.js';

// Search
export { searchMemories } from './search.js';

// Filter (pure functions)
export { applySkillFilter, filterByTags } from './filter.js';

// Stats
export { getMemoryStats } from './stats.js';

// Access tracking
export { touchMemory, touchMemories } from './access-tracking.js';
