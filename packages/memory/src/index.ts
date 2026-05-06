// @nodalai/memory — public API

// Types
export type {
  SearchOptions,
  ListOptions,
  PagedResult,
  MemoryStats,
  MemorySortField,
} from './types';

// Errors
export { MemoryError, MemoryNotFoundError } from './errors';
export type { MemoryErrorCode } from './errors';

// CRUD
export { getMemory, createMemory, updateMemory, deleteMemory, rowToMemory } from './crud';
export type { MemoryRow } from './crud';

// List
export { listMemories } from './list';

// Search
export { searchMemories } from './search';

// Filter (pure functions)
export { applySkillFilter, filterByTags } from './filter';

// Stats
export { getMemoryStats } from './stats';

// Access tracking
export { touchMemory, touchMemories } from './access-tracking';
