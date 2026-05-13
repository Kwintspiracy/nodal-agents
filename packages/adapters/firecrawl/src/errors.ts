// @nodal-agents/adapter-firecrawl — typed error codes, no user-facing strings

export type FirecrawlErrorCode =
  | 'firecrawl_unauthorized'
  | 'firecrawl_forbidden'
  | 'firecrawl_not_found'
  | 'firecrawl_validation_error'
  | 'firecrawl_rate_limited'
  | 'firecrawl_transient'
  | 'firecrawl_client_error'
  | 'firecrawl_unknown';

export class FirecrawlApiError extends Error {
  readonly code: FirecrawlErrorCode;
  readonly status: number | undefined;

  constructor(code: FirecrawlErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'FirecrawlApiError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Map an HTTP status and body message to a typed FirecrawlApiError.
 * Called after any non-2xx response from the Firecrawl API.
 *
 * Status mapping:
 *   401 → unauthorized  (invalid or missing API key)
 *   403 → forbidden
 *   404 → not_found
 *   422 → validation_error
 *   429 → rate_limited
 *   5xx → transient      (Firecrawl server-side error; safe to retry)
 *   other 4xx → client_error
 */
export function mapFirecrawlHttpError(status: number, message: string): FirecrawlApiError {
  let code: FirecrawlErrorCode;

  switch (true) {
    case status === 401:
      code = 'firecrawl_unauthorized';
      break;
    case status === 403:
      code = 'firecrawl_forbidden';
      break;
    case status === 404:
      code = 'firecrawl_not_found';
      break;
    case status === 422:
      code = 'firecrawl_validation_error';
      break;
    case status === 429:
      code = 'firecrawl_rate_limited';
      break;
    case status >= 500:
      code = 'firecrawl_transient';
      break;
    default:
      code = 'firecrawl_client_error';
  }

  return new FirecrawlApiError(code, message, status);
}

/**
 * Wrap any unknown thrown value in a FirecrawlApiError.
 * Used as the catch handler in every tool execute().
 */
export function wrapFirecrawlError(err: unknown): FirecrawlApiError {
  if (err instanceof FirecrawlApiError) return err;
  if (err instanceof Error) return new FirecrawlApiError('firecrawl_unknown', err.message);
  return new FirecrawlApiError('firecrawl_unknown', String(err));
}
