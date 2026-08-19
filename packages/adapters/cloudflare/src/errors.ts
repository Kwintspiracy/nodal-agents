// @nodal-agents/adapter-cloudflare — typed error codes, no user-facing strings

export type CloudflareErrorCode =
  | 'cloudflare_unauthorized'
  | 'cloudflare_forbidden'
  | 'cloudflare_not_found'
  | 'cloudflare_validation_error'
  | 'cloudflare_rate_limited'
  | 'cloudflare_transient'
  | 'cloudflare_client_error'
  | 'cloudflare_no_account'
  | 'cloudflare_multiple_accounts'
  | 'cloudflare_subdomain_missing'
  | 'cloudflare_deploy_failed'
  | 'cloudflare_unknown';

export class CloudflareApiError extends Error {
  readonly code: CloudflareErrorCode;
  readonly status: number | undefined;

  constructor(code: CloudflareErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'CloudflareApiError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Map an HTTP status + body message to a typed CloudflareApiError.
 * Same mapping discipline as the firecrawl adapter:
 *   401 → unauthorized  (invalid or expired API token)
 *   403 → forbidden     (token lacks a permission — see the docsHint scopes)
 *   404 → not_found
 *   422/400 → validation_error
 *   429 → rate_limited
 *   5xx → transient
 *   other 4xx → client_error
 */
export function mapCloudflareHttpError(status: number, message: string): CloudflareApiError {
  let code: CloudflareErrorCode;
  if (status === 401) code = 'cloudflare_unauthorized';
  else if (status === 403) code = 'cloudflare_forbidden';
  else if (status === 404) code = 'cloudflare_not_found';
  else if (status === 400 || status === 422) code = 'cloudflare_validation_error';
  else if (status === 429) code = 'cloudflare_rate_limited';
  else if (status >= 500) code = 'cloudflare_transient';
  else if (status >= 400) code = 'cloudflare_client_error';
  else code = 'cloudflare_unknown';
  return new CloudflareApiError(code, message, status);
}
