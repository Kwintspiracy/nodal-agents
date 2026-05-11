// @nodalai/adapter-airtable — typed error codes, no user-facing strings

export type AirtableErrorCode =
  | 'airtable_unauthorized'
  | 'airtable_forbidden'
  | 'airtable_not_found'
  | 'airtable_validation_error'
  | 'airtable_rate_limited'
  | 'airtable_transient'
  | 'airtable_client_error'
  | 'airtable_unknown';

export class AirtableApiError extends Error {
  readonly code: AirtableErrorCode;
  readonly status: number | undefined;

  constructor(code: AirtableErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'AirtableApiError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Map an HTTP status and body message to a typed AirtableApiError.
 * Called after any non-2xx response from the Airtable REST API.
 *
 * Status mapping:
 *   401 → unauthorized  (signal to refresh and retry — path not yet wired in runner)
 *   403 → forbidden
 *   404 → not_found
 *   422 → validation_error
 *   429 → rate_limited
 *   5xx → transient      (Airtable server-side error; safe to retry)
 *   other 4xx → client_error
 */
export function mapAirtableHttpError(status: number, message: string): AirtableApiError {
  let code: AirtableErrorCode;

  switch (true) {
    case status === 401:
      code = 'airtable_unauthorized';
      break;
    case status === 403:
      code = 'airtable_forbidden';
      break;
    case status === 404:
      code = 'airtable_not_found';
      break;
    case status === 422:
      code = 'airtable_validation_error';
      break;
    case status === 429:
      code = 'airtable_rate_limited';
      break;
    case status >= 500:
      code = 'airtable_transient';
      break;
    default:
      code = 'airtable_client_error';
  }

  return new AirtableApiError(code, message, status);
}

/**
 * Wrap any unknown thrown value in an AirtableApiError.
 * Used as the catch handler in every tool execute().
 */
export function wrapAirtableError(err: unknown): AirtableApiError {
  if (err instanceof AirtableApiError) return err;
  if (err instanceof Error) return new AirtableApiError('airtable_unknown', err.message);
  return new AirtableApiError('airtable_unknown', String(err));
}
