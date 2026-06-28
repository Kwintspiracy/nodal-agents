// @nodal-agents/adapter-poyo — typed error codes, no user-facing strings

export type PoyoErrorCode =
  | 'poyo_unauthorized'
  | 'poyo_forbidden'
  | 'poyo_not_found'
  | 'poyo_validation_error'
  | 'poyo_rate_limited'
  | 'poyo_transient'
  | 'poyo_client_error'
  | 'poyo_generation_failed'
  | 'poyo_unknown';

export class PoyoApiError extends Error {
  readonly code: PoyoErrorCode;
  readonly status: number | undefined;

  constructor(code: PoyoErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'PoyoApiError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Map an HTTP status and body message to a typed PoyoApiError.
 * Called after any non-2xx response from the Poyo API.
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
export function mapPoyoHttpError(status: number, message: string): PoyoApiError {
  let code: PoyoErrorCode;

  switch (true) {
    case status === 401:
      code = 'poyo_unauthorized';
      break;
    case status === 403:
      code = 'poyo_forbidden';
      break;
    case status === 404:
      code = 'poyo_not_found';
      break;
    case status === 422:
      code = 'poyo_validation_error';
      break;
    case status === 429:
      code = 'poyo_rate_limited';
      break;
    case status >= 500:
      code = 'poyo_transient';
      break;
    default:
      code = 'poyo_client_error';
  }

  return new PoyoApiError(code, message, status);
}

/**
 * Wrap any unknown thrown value in a PoyoApiError.
 * Used as the catch handler in every tool execute().
 */
export function wrapPoyoError(err: unknown): PoyoApiError {
  if (err instanceof PoyoApiError) return err;
  if (err instanceof Error) return new PoyoApiError('poyo_unknown', err.message);
  return new PoyoApiError('poyo_unknown', String(err));
}
