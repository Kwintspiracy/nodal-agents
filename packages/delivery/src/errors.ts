// errors.ts — DeliveryError with typed codes

export type DeliveryErrorCode =
  | 'telegram_unauthorized'
  | 'telegram_chat_not_found'
  | 'telegram_rate_limited'
  | 'telegram_request_failed'
  | 'telegram_no_token'
  | 'telegram_no_chat_id'
  | 'delivery_email_not_configured'
  | 'delivery_job_not_found'
  | 'delivery_no_content';

export class DeliveryError extends Error {
  readonly code: DeliveryErrorCode;

  constructor(code: DeliveryErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'DeliveryError';
    this.code = code;
  }
}
