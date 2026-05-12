// @nodalai/adapter-apify — typed error codes, no user-facing strings

export type ApifyErrorCode =
  | 'apify_unauthorized'
  | 'apify_forbidden'
  | 'apify_not_found'
  | 'apify_validation_error'
  | 'apify_rate_limited'
  | 'apify_transient'
  | 'apify_client_error'
  | 'apify_unknown';

export class ApifyApiError extends Error {
  readonly code: ApifyErrorCode;
  readonly status: number | undefined;

  constructor(code: ApifyErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'ApifyApiError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Map an HTTP status to a typed ApifyApiError.
 * The apify-client SDK throws an ApifyApiError with statusCode on non-2xx responses.
 *
 * Status mapping:
 *   401 → unauthorized
 *   403 → forbidden
 *   404 → not_found
 *   422 → validation_error
 *   429 → rate_limited
 *   5xx → transient
 *   other 4xx → client_error
 */
export function mapApifyHttpError(status: number, message: string): ApifyApiError {
  let code: ApifyErrorCode;

  switch (true) {
    case status === 401:
      code = 'apify_unauthorized';
      break;
    case status === 403:
      code = 'apify_forbidden';
      break;
    case status === 404:
      code = 'apify_not_found';
      break;
    case status === 422:
      code = 'apify_validation_error';
      break;
    case status === 429:
      code = 'apify_rate_limited';
      break;
    case status >= 500:
      code = 'apify_transient';
      break;
    default:
      code = 'apify_client_error';
  }

  return new ApifyApiError(code, message, status);
}

/**
 * Wrap any unknown thrown value (including apify-client SDK errors) in an ApifyApiError.
 * The SDK throws objects with a `statusCode` property on API errors.
 */
export function wrapApifyError(err: unknown): ApifyApiError {
  if (err instanceof ApifyApiError) return err;

  // apify-client SDK throws objects with statusCode + message
  if (
    err !== null &&
    typeof err === 'object' &&
    'statusCode' in err &&
    typeof (err as { statusCode: unknown }).statusCode === 'number'
  ) {
    const sdkErr = err as { statusCode: number; message?: string };
    const message = sdkErr.message ?? `Apify API error ${sdkErr.statusCode}`;
    return mapApifyHttpError(sdkErr.statusCode, message);
  }

  if (err instanceof Error) return new ApifyApiError('apify_unknown', err.message);
  return new ApifyApiError('apify_unknown', String(err));
}
