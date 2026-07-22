// @nodal-agents/adapter-outlook-mail — typed error codes, no user-facing strings

export type OutlookErrorCode =
  | 'outlook_unauthorized'
  | 'outlook_forbidden'
  | 'outlook_not_found'
  | 'outlook_quota_exceeded'
  | 'outlook_validation_error'
  | 'outlook_service_unavailable'
  | 'outlook_attachment_too_large'
  | 'outlook_attachment_unsupported_type'
  | 'outlook_unknown';

export class OutlookAdapterError extends Error {
  readonly code: OutlookErrorCode;
  readonly status: number | undefined;
  /** Seconds to wait before retrying, parsed from a Graph 429 response's Retry-After header. */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: OutlookErrorCode,
    message: string,
    status?: number,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'OutlookAdapterError';
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Duck-typed shape of a @microsoft/microsoft-graph-client GraphError (and of
 * the plain objects tests mock it with, matching adapter-gmail's convention
 * of not requiring `instanceof` on the real SDK error class).
 */
interface GraphErrorLike {
  statusCode?: number;
  message?: string;
  headers?: { get?: (name: string) => string | null };
}

function isGraphErrorLike(err: unknown): err is GraphErrorLike {
  return typeof err === 'object' && err !== null && 'statusCode' in err;
}

/**
 * Map a @microsoft/microsoft-graph-client GraphError (or any unknown error)
 * to a typed OutlookAdapterError.
 */
export function mapOutlookError(err: unknown): OutlookAdapterError {
  if (err instanceof OutlookAdapterError) {
    return err;
  }

  if (isGraphErrorLike(err)) {
    const status = typeof err.statusCode === 'number' ? err.statusCode : undefined;
    const message = typeof err.message === 'string' ? err.message : String(err);

    if (status !== undefined) {
      if (status === 429) {
        const retryAfterHeader = err.headers?.get?.('Retry-After');
        const parsedRetryAfter = retryAfterHeader ? Number(retryAfterHeader) : undefined;
        return new OutlookAdapterError(
          'outlook_quota_exceeded',
          message,
          status,
          parsedRetryAfter !== undefined && Number.isFinite(parsedRetryAfter)
            ? parsedRetryAfter
            : undefined,
        );
      }

      let code: OutlookErrorCode;
      switch (status) {
        case 400:
          code = 'outlook_validation_error';
          break;
        case 401:
          code = 'outlook_unauthorized';
          break;
        case 403:
          code = 'outlook_forbidden';
          break;
        case 404:
          code = 'outlook_not_found';
          break;
        default:
          code = status >= 500 ? 'outlook_service_unavailable' : 'outlook_unknown';
      }
      return new OutlookAdapterError(code, message, status);
    }
  }

  if (err instanceof Error) {
    return new OutlookAdapterError('outlook_unknown', err.message);
  }

  return new OutlookAdapterError('outlook_unknown', String(err));
}
