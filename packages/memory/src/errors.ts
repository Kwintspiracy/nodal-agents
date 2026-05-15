// @nodal-agents/memory — error types

export type MemoryErrorCode =
  | 'MEMORY_NOT_FOUND'
  | 'INVALID_ENTITY'
  | 'INVALID_INPUT'
  | 'INVALID_PAGE'
  | 'INVALID_PAGE_SIZE'
  | 'DB_ERROR'
  | 'EMBED_ERROR'
  | 'MEMORY_SANITATION'
  | 'MEMORY_DUPLICATE';

export class MemoryError extends Error {
  readonly code: MemoryErrorCode;

  constructor(code: MemoryErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'MemoryError';
    this.code = code;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export class MemoryNotFoundError extends MemoryError {
  constructor(id: string) {
    super('MEMORY_NOT_FOUND', `memory.not_found:${id}`);
    this.name = 'MemoryNotFoundError';
  }
}

/**
 * Raised by sanitizeMemoryContent() when a fact contains an injection /
 * exfiltration payload or invisible unicode. `threatId` identifies the matched
 * pattern; `detail` is a human-readable explanation safe to surface to the LLM.
 */
export class MemorySanitationError extends MemoryError {
  readonly threatId: string;
  readonly detail: string;

  constructor(threatId: string, detail: string) {
    super('MEMORY_SANITATION', `memory.sanitation_blocked:${threatId}`);
    this.name = 'MemorySanitationError';
    this.threatId = threatId;
    this.detail = detail;
  }
}

/**
 * Raised by createMemory() when an identical fact (same normalized content)
 * already exists for the entity and is not archived. `existingId` points at the
 * row that already holds this knowledge.
 */
export class MemoryDuplicateError extends MemoryError {
  readonly existingId: string;

  constructor(existingId: string) {
    super('MEMORY_DUPLICATE', `memory.duplicate:${existingId}`);
    this.name = 'MemoryDuplicateError';
    this.existingId = existingId;
  }
}
