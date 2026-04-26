// @nodalai/memory — error types

export type MemoryErrorCode =
  | 'MEMORY_NOT_FOUND'
  | 'INVALID_ENTITY'
  | 'INVALID_PAGE'
  | 'INVALID_PAGE_SIZE'
  | 'DB_ERROR'
  | 'EMBED_ERROR';

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
