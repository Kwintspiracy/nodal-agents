// @nodal-agents/adapter-gmail — typed error codes, no user-facing strings

export type GmailErrorCode =
  | 'gmail_unauthorized'
  | 'gmail_forbidden'
  | 'gmail_message_not_found'
  | 'gmail_thread_not_found'
  | 'gmail_label_not_found'
  | 'gmail_draft_not_found'
  | 'gmail_quota_exceeded'
  | 'gmail_invalid_recipient'
  | 'gmail_validation_error'
  | 'gmail_service_unavailable'
  | 'gmail_attachment_too_large'
  | 'gmail_unknown';

export class GmailAdapterError extends Error {
  readonly code: GmailErrorCode;
  readonly status: number | undefined;

  constructor(code: GmailErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'GmailAdapterError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Map a googleapis error (or any unknown error) to a typed GmailAdapterError.
 * googleapis errors carry a `.code` (number) and `.errors` array.
 */
export function mapGmailError(err: unknown): GmailAdapterError {
  // googleapis errors: { code: number, message: string, errors: [...] }
  if (typeof err === 'object' && err !== null) {
    const e = err as Record<string, unknown>;
    const status = typeof e['code'] === 'number' ? e['code'] : undefined;
    const message = typeof e['message'] === 'string' ? e['message'] : String(err);

    if (status !== undefined) {
      let code: GmailErrorCode;
      switch (status) {
        case 400:
          code = 'gmail_validation_error';
          break;
        case 401:
          code = 'gmail_unauthorized';
          break;
        case 403:
          code = 'gmail_forbidden';
          break;
        case 404:
          code = 'gmail_message_not_found';
          break;
        case 429:
          code = 'gmail_quota_exceeded';
          break;
        case 503:
          code = 'gmail_service_unavailable';
          break;
        default:
          code = 'gmail_unknown';
      }
      return new GmailAdapterError(code, message, status);
    }
  }

  if (err instanceof GmailAdapterError) {
    return err;
  }

  if (err instanceof Error) {
    return new GmailAdapterError('gmail_unknown', err.message);
  }

  return new GmailAdapterError('gmail_unknown', String(err));
}
