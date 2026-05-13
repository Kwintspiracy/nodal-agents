// @nodal-agents/adapter-google-sheets — typed error codes, no user-facing strings

export type SheetsErrorCode =
  | 'sheets_unauthorized'
  | 'sheets_forbidden'
  | 'sheets_not_found'
  | 'sheets_rate_limited'
  | 'sheets_invalid_range'
  | 'sheets_range_too_large'
  | 'sheets_validation_error'
  | 'sheets_service_unavailable'
  | 'sheets_unknown';

export class SheetsAdapterError extends Error {
  readonly code: SheetsErrorCode;
  readonly status: number | undefined;

  constructor(code: SheetsErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'SheetsAdapterError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Map a googleapis error (or any unknown error) to a typed SheetsAdapterError.
 * googleapis errors carry a `.code` (number) and `.errors` array.
 */
export function mapSheetsError(err: unknown): SheetsAdapterError {
  // googleapis errors: { code: number, message: string, errors: [...] }
  if (typeof err === 'object' && err !== null) {
    const e = err as Record<string, unknown>;
    const status = typeof e['code'] === 'number' ? e['code'] : undefined;
    const message = typeof e['message'] === 'string' ? e['message'] : String(err);

    if (status !== undefined) {
      let code: SheetsErrorCode;
      switch (status) {
        case 400: {
          // Detect invalid range specifically
          const msg = message.toLowerCase();
          if (
            msg.includes('range') ||
            msg.includes('a1 notation') ||
            msg.includes('unable to parse')
          ) {
            code = 'sheets_invalid_range';
          } else {
            code = 'sheets_validation_error';
          }
          break;
        }
        case 401:
          code = 'sheets_unauthorized';
          break;
        case 403:
          code = 'sheets_forbidden';
          break;
        case 404:
          code = 'sheets_not_found';
          break;
        case 429:
          code = 'sheets_rate_limited';
          break;
        case 503:
          code = 'sheets_service_unavailable';
          break;
        default:
          code = 'sheets_unknown';
      }
      return new SheetsAdapterError(code, message, status);
    }
  }

  if (err instanceof SheetsAdapterError) {
    return err;
  }

  if (err instanceof Error) {
    return new SheetsAdapterError('sheets_unknown', err.message);
  }

  return new SheetsAdapterError('sheets_unknown', String(err));
}
