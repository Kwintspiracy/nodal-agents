// @nodal-agents/adapter-google-calendar — typed error codes, no user-facing strings

export type GoogleCalendarErrorCode =
  | 'gcal_unauthorized'
  | 'gcal_forbidden'
  | 'gcal_calendar_not_found'
  | 'gcal_event_not_found'
  | 'gcal_quota_exceeded'
  | 'gcal_validation_error'
  | 'gcal_service_unavailable'
  | 'gcal_unknown';

export class GoogleCalendarAdapterError extends Error {
  readonly code: GoogleCalendarErrorCode;
  readonly status: number | undefined;

  constructor(code: GoogleCalendarErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'GoogleCalendarAdapterError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Map a googleapis error (or any unknown error) to a typed adapter error.
 * googleapis errors carry a `.code` (number) and `.errors` array.
 */
export function mapGoogleCalendarError(err: unknown): GoogleCalendarAdapterError {
  if (typeof err === 'object' && err !== null) {
    const e = err as Record<string, unknown>;
    const status = typeof e['code'] === 'number' ? e['code'] : undefined;
    const message = typeof e['message'] === 'string' ? e['message'] : String(err);

    if (status !== undefined) {
      let code: GoogleCalendarErrorCode;
      switch (status) {
        case 400:
          code = 'gcal_validation_error';
          break;
        case 401:
          code = 'gcal_unauthorized';
          break;
        case 403:
          code = 'gcal_forbidden';
          break;
        case 404:
          code = 'gcal_event_not_found';
          break;
        case 429:
          code = 'gcal_quota_exceeded';
          break;
        case 503:
          code = 'gcal_service_unavailable';
          break;
        default:
          code = 'gcal_unknown';
      }
      return new GoogleCalendarAdapterError(code, message, status);
    }
  }

  if (err instanceof GoogleCalendarAdapterError) {
    return err;
  }

  if (err instanceof Error) {
    return new GoogleCalendarAdapterError('gcal_unknown', err.message);
  }

  return new GoogleCalendarAdapterError('gcal_unknown', String(err));
}
