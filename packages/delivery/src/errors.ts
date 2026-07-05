// errors.ts — DeliveryError with typed codes

export type DeliveryErrorCode =
  | 'telegram_unauthorized'
  | 'telegram_chat_not_found'
  | 'telegram_rate_limited'
  | 'telegram_request_failed'
  | 'telegram_invalid_token'
  | 'telegram_no_token'
  | 'telegram_no_chat_id'
  | 'telegram_file_too_large'
  | 'delivery_email_not_configured'
  | 'delivery_job_not_found'
  | 'delivery_no_content';

/**
 * Progress info attached to a DeliveryError thrown mid-way through a chunked
 * send (F-4): how many chunks already reached Telegram before the failure, so
 * a caller that retries can resume from `sentChunks` instead of resending the
 * whole message and duplicating what already went out.
 */
export interface DeliveryPartialProgress {
  sentChunks: number;
  totalChunks: number;
}

export class DeliveryError extends Error {
  readonly code: DeliveryErrorCode;
  /** Set on `telegram_rate_limited`: Telegram's requested backoff, in ms, when it provided one (429 `parameters.retry_after`). */
  retryAfterMs?: number;
  /** Set when a chunked send fails partway through — see `DeliveryPartialProgress`. */
  partialProgress?: DeliveryPartialProgress;

  constructor(code: DeliveryErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'DeliveryError';
    this.code = code;
  }
}
