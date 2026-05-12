// @nodalai/adapter-tavily — typed error codes, no user-facing strings

export type TavilyErrorCode =
  | 'tavily_unauthorized'
  | 'tavily_forbidden'
  | 'tavily_not_found'
  | 'tavily_validation_error'
  | 'tavily_rate_limited'
  | 'tavily_transient'
  | 'tavily_client_error'
  | 'tavily_unknown';

export class TavilyApiError extends Error {
  readonly code: TavilyErrorCode;
  readonly status: number | undefined;

  constructor(code: TavilyErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'TavilyApiError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Map an HTTP status and body message to a typed TavilyApiError.
 * Called after any non-2xx response from the Tavily API.
 *
 * Status mapping:
 *   401 → unauthorized
 *   403 → forbidden
 *   404 → not_found
 *   422 → validation_error
 *   429 → rate_limited
 *   5xx → transient      (server-side error; safe to retry)
 *   other 4xx → client_error
 */
export function mapTavilyHttpError(status: number, message: string): TavilyApiError {
  let code: TavilyErrorCode;

  switch (true) {
    case status === 401:
      code = 'tavily_unauthorized';
      break;
    case status === 403:
      code = 'tavily_forbidden';
      break;
    case status === 404:
      code = 'tavily_not_found';
      break;
    case status === 422:
      code = 'tavily_validation_error';
      break;
    case status === 429:
      code = 'tavily_rate_limited';
      break;
    case status >= 500:
      code = 'tavily_transient';
      break;
    default:
      code = 'tavily_client_error';
  }

  return new TavilyApiError(code, message, status);
}

/**
 * Wrap any unknown thrown value in a TavilyApiError.
 * Used as the catch handler in every tool execute().
 */
export function wrapTavilyError(err: unknown): TavilyApiError {
  if (err instanceof TavilyApiError) return err;
  if (err instanceof Error) {
    // The @tavily/core SDK throws errors with HTTP status info embedded in the message.
    // Attempt to extract a status code from the message if present.
    const statusMatch = /status[:\s]+(\d{3})/i.exec(err.message);
    if (statusMatch) {
      const status = parseInt(statusMatch[1] ?? '0', 10);
      return mapTavilyHttpError(status, err.message);
    }
    return new TavilyApiError('tavily_unknown', err.message);
  }
  return new TavilyApiError('tavily_unknown', String(err));
}
