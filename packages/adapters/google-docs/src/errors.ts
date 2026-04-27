// @nodalai/adapter-google-docs — typed error codes, no user-facing strings

export type DocsErrorCode =
  | 'docs_unauthorized'
  | 'docs_forbidden'
  | 'docs_not_found'
  | 'docs_rate_limited'
  | 'docs_invalid_request'
  | 'docs_document_too_large'
  | 'docs_service_unavailable'
  | 'docs_unknown';

export class DocsAdapterError extends Error {
  readonly code: DocsErrorCode;
  readonly status: number | undefined;

  constructor(code: DocsErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'DocsAdapterError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Map a googleapis error (or any unknown error) to a typed DocsAdapterError.
 * googleapis errors carry a `.code` (number) and `.errors` array.
 */
export function mapDocsError(err: unknown): DocsAdapterError {
  // googleapis errors: { code: number, message: string, errors: [...] }
  if (typeof err === 'object' && err !== null) {
    const e = err as Record<string, unknown>;
    const status = typeof e['code'] === 'number' ? e['code'] : undefined;
    const message = typeof e['message'] === 'string' ? e['message'] : String(err);

    if (status !== undefined) {
      let code: DocsErrorCode;
      switch (status) {
        case 400:
          code = 'docs_invalid_request';
          break;
        case 401:
          code = 'docs_unauthorized';
          break;
        case 403:
          code = 'docs_forbidden';
          break;
        case 404:
          code = 'docs_not_found';
          break;
        case 429:
          code = 'docs_rate_limited';
          break;
        case 503:
          code = 'docs_service_unavailable';
          break;
        default:
          code = 'docs_unknown';
      }
      return new DocsAdapterError(code, message, status);
    }
  }

  if (err instanceof DocsAdapterError) {
    return err;
  }

  if (err instanceof Error) {
    return new DocsAdapterError('docs_unknown', err.message);
  }

  return new DocsAdapterError('docs_unknown', String(err));
}
