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
 * Wrap any unknown thrown value (including @mendable/firecrawl-js SDK errors)
 * in a FirecrawlApiError. Used as the catch handler in every tool execute().
 *
 * The v2 SDK (FirecrawlClient, used here) throws `SdkError` — name
 * 'FirecrawlSdkError' — carrying a `status` property (number | undefined) set
 * from the HTTP response status (see throwForBadResponse/normalizeAxiosError
 * in the SDK). Before this fix, mapFirecrawlHttpError was never called from
 * here, so every SDK error — 429, 401, 5xx included — fell through to the
 * generic `err instanceof Error` branch and lost its status (audit#2 F-15),
 * same class of bug the Apify adapter's wrapApifyError already avoids by
 * reading the SDK's `statusCode` property.
 */
export function wrapFirecrawlError(err: unknown): FirecrawlApiError {
  if (err instanceof FirecrawlApiError) return err;

  if (
    err !== null &&
    typeof err === 'object' &&
    'status' in err &&
    typeof (err as { status: unknown }).status === 'number'
  ) {
    const sdkErr = err as { status: number; message?: string };
    const message = sdkErr.message ?? `Firecrawl API error ${sdkErr.status}`;
    return mapFirecrawlHttpError(sdkErr.status, message);
  }

  if (err instanceof Error) return new FirecrawlApiError('firecrawl_unknown', err.message);
  return new FirecrawlApiError('firecrawl_unknown', String(err));
}
