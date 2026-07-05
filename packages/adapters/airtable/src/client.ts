// @nodal-agents/adapter-airtable — thin fetch wrapper + auth + error mapping
// Airtable REST API: https://api.airtable.com/v0
// Auth: Authorization: Bearer <token> — same wire format for OAuth tokens and PATs.

import { mapAirtableHttpError, wrapAirtableError, AirtableApiError } from './errors.ts';

const BASE_URL = 'https://api.airtable.com/v0';

// audit#2 M-15: an endpoint that accepts the connection but never responds
// must not hang the tool call forever. 30s is generous for a normal Airtable
// REST call.
const DEFAULT_TIMEOUT_MS = 30_000;

export type AirtableClient = {
  get: (
    path: string,
    params?: Record<string, string | number | boolean | string[]>,
  ) => Promise<unknown>;
  post: (path: string, body: unknown) => Promise<unknown>;
  patch: (path: string, body: unknown) => Promise<unknown>;
  put: (path: string, body: unknown) => Promise<unknown>;
  delete: (path: string) => Promise<unknown>;
};

export type AirtableClientOptions = {
  /** Per-request timeout in ms (audit#2 M-15). Defaults to 30s. */
  timeoutMs?: number;
};

/**
 * Create a thin Airtable API client. The token is resolved lazily — before
 * every request — instead of captured once at construction time.
 *
 * Airtable OAuth2 access tokens live ~60min; a job can run far longer than
 * that (IDLE_RESET is 4h). Capturing a single token at setup meant a job
 * outliving that window got a spurious 401 even though the underlying
 * credential was still valid and refreshable (audit#2 M-12 — same root cause
 * as the 5 Google adapters, just without google-auth-library's refreshHandler
 * extension point: this client hand-rolls its own fetch, so it simply calls
 * getAccessToken() again right before building each request's headers).
 *
 * Both OAuth access tokens and Personal Access Tokens use the same
 * `Authorization: Bearer <token>` wire format — the client doesn't care which
 * (a PAT caller just passes a resolver that always returns the same string).
 */
export function createAirtableClient(
  getAccessToken: () => Promise<string>,
  options: AirtableClientOptions = {},
): AirtableClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers = async (): Promise<Record<string, string>> => ({
    Authorization: `Bearer ${await getAccessToken()}`,
    'Content-Type': 'application/json',
  });

  async function request(method: string, url: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: await headers(),
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new AirtableApiError(
          'airtable_transient',
          `Airtable request to ${url} timed out after ${timeoutMs}ms`,
        );
      }
      throw wrapAirtableError(err);
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      data = {};
    }

    if (!response.ok) {
      const errBody = data as { error?: { message?: string } | string; message?: string };
      let message: string;
      if (typeof errBody?.error === 'object' && errBody.error !== null) {
        message = errBody.error.message ?? response.statusText;
      } else if (typeof errBody?.error === 'string') {
        message = errBody.error;
      } else if (errBody?.message) {
        message = errBody.message;
      } else {
        message = response.statusText;
      }
      throw mapAirtableHttpError(response.status, message);
    }

    return data;
  }

  function buildUrl(
    basePath: string,
    path: string,
    params?: Record<string, string | number | boolean | string[]>,
  ): string {
    const url = new URL(`${basePath}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (Array.isArray(value)) {
          for (const v of value) {
            url.searchParams.append(key, String(v));
          }
        } else if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  return {
    get(path, params) {
      // All Airtable endpoints — including /meta/bases — live under /v0/.
      const fullUrl = buildUrl(BASE_URL, path, params);
      return request('GET', fullUrl);
    },
    post(path, body) {
      return request('POST', `${BASE_URL}${path}`, body);
    },
    patch(path, body) {
      return request('PATCH', `${BASE_URL}${path}`, body);
    },
    put(path, body) {
      return request('PUT', `${BASE_URL}${path}`, body);
    },
    delete(path) {
      return request('DELETE', `${BASE_URL}${path}`);
    },
  };
}

// Re-export error types used by tools
export { AirtableApiError };
