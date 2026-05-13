// @nodal-agents/adapter-notion — typed error codes, no user-facing strings

import { APIResponseError } from '@notionhq/client';

export type NotionErrorCode =
  | 'notion_unauthorized'
  | 'notion_forbidden'
  | 'notion_not_found'
  | 'notion_conflict'
  | 'notion_rate_limited'
  | 'notion_validation_error'
  | 'notion_service_unavailable'
  | 'notion_unknown';

export class NotionAdapterError extends Error {
  readonly code: NotionErrorCode;
  readonly status: number | undefined;

  constructor(code: NotionErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'NotionAdapterError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Map a @notionhq/client APIResponseError to our typed NotionAdapterError.
 * Preserves original HTTP status for diagnostics.
 */
export function mapNotionError(err: unknown): NotionAdapterError {
  if (err instanceof APIResponseError) {
    const status = err.status;
    let code: NotionErrorCode;
    switch (status) {
      case 400:
        code = 'notion_validation_error';
        break;
      case 401:
        code = 'notion_unauthorized';
        break;
      case 403:
        code = 'notion_forbidden';
        break;
      case 404:
        code = 'notion_not_found';
        break;
      case 409:
        code = 'notion_conflict';
        break;
      case 429:
        code = 'notion_rate_limited';
        break;
      case 503:
        code = 'notion_service_unavailable';
        break;
      default:
        code = 'notion_unknown';
    }
    return new NotionAdapterError(code, err.message, status);
  }

  if (err instanceof Error) {
    return new NotionAdapterError('notion_unknown', err.message);
  }

  return new NotionAdapterError('notion_unknown', String(err));
}
