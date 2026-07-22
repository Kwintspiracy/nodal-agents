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
  | 'slack_no_token'
  | 'slack_no_channel_id'
  | 'slack_invalid_token'
  /** validateCredentials: the socket for this session never reached 'open'
   *  with existing device keys (or the sessionDir credential is missing) —
   *  this WhatsApp account isn't linked (see whatsapp-adapter.ts). Distinct
   *  from `send_failed` because "not paired" is an actionable, specific
   *  state (go pair the device), not a generic transport failure. */
  | 'whatsapp_not_paired'
  /** Generic send failure for the WhatsApp adapter (missing credential/
   *  conversationId, socket not open, or a Baileys sendMessage() throw). */
  | 'whatsapp_send_failed'
  | 'delivery_email_not_configured'
  | 'delivery_job_not_found'
  | 'delivery_no_content'
  | 'channel_adapter_not_found'
  /** Generic send failure for a channel adapter without a more specific code
   *  of its own — Discord's and Slack's own API/HTTP-level failures land here
   *  (mirrors what telegram_request_failed is for Telegram); a future channel
   *  grows its own granular taxonomy only once a real caller needs to
   *  distinguish a failure mode. */
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
  /**
   * Set on send timeouts: the request was transmitted but the platform never
   * answered, so the message MAY have been delivered (Telegram often delivers
   * while answering late). Callers must NOT blindly resend — that is exactly
   * the case that duplicates messages. Surface the ambiguity instead.
   */
  mayHaveDelivered?: boolean;

  constructor(code: DeliveryErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'DeliveryError';
    this.code = code;
  }
}
