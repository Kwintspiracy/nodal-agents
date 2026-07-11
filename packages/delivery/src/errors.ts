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
  | 'discord_no_token'
  | 'discord_no_channel_id'
  | 'discord_invalid_token'
  | 'delivery_email_not_configured'
  | 'delivery_job_not_found'
  | 'delivery_no_content'
  | 'channel_adapter_not_found'
  /** Generic send failure for a channel adapter without a more specific code
   *  of its own (e.g. a future Slack adapter before it grows its own granular
   *  error taxonomy, or Discord's own API/HTTP-level failures — mirrors what
   *  telegram_request_failed is for Telegram). */
  | 'send_failed';

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
