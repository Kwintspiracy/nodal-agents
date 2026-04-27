// @nodalai/adapter-google-drive — typed error codes, no user-facing strings

export type DriveErrorCode =
  | 'drive_unauthorized'
  | 'drive_forbidden'
  | 'drive_not_found'
  | 'drive_conflict'
  | 'drive_rate_limited'
  | 'drive_validation_error'
  | 'drive_service_unavailable'
  | 'drive_file_too_large'
  | 'drive_pptx_extraction_unsupported'
  | 'drive_unknown';

export class DriveAdapterError extends Error {
  readonly code: DriveErrorCode;
  readonly status: number | undefined;

  constructor(code: DriveErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'DriveAdapterError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Map a googleapis error (or any unknown error) to a typed DriveAdapterError.
 * googleapis errors carry a `.code` (number) and `.errors` array.
 */
export function mapDriveError(err: unknown): DriveAdapterError {
  // googleapis errors: { code: number, message: string, errors: [...] }
  if (typeof err === 'object' && err !== null) {
    const e = err as Record<string, unknown>;
    const status = typeof e['code'] === 'number' ? e['code'] : undefined;
    const message = typeof e['message'] === 'string' ? e['message'] : String(err);

    if (status !== undefined) {
      let code: DriveErrorCode;
      switch (status) {
        case 400:
          code = 'drive_validation_error';
          break;
        case 401:
          code = 'drive_unauthorized';
          break;
        case 403:
          code = 'drive_forbidden';
          break;
        case 404:
          code = 'drive_not_found';
          break;
        case 409:
          code = 'drive_conflict';
          break;
        case 429:
          code = 'drive_rate_limited';
          break;
        case 503:
          code = 'drive_service_unavailable';
          break;
        default:
          code = 'drive_unknown';
      }
      return new DriveAdapterError(code, message, status);
    }
  }

  if (err instanceof DriveAdapterError) {
    return err;
  }

  if (err instanceof Error) {
    return new DriveAdapterError('drive_unknown', err.message);
  }

  return new DriveAdapterError('drive_unknown', String(err));
}
