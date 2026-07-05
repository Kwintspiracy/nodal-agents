// @nodal-agents/adapter-poyo — hand-rolled HTTP client for the Poyo API.
//
// Poyo (https://poyo.ai) has no official SDK, so this is a thin fetch wrapper.
// Async two-endpoint design:
//   POST /api/generate/submit          → { data: { task_id } }
//   GET  /api/generate/status/{taskId} → { data: { status, progress, files[] } }
// Auth: Bearer <api key> in the Authorization header.

import { mapPoyoHttpError, PoyoApiError } from './errors.ts';

const DEFAULT_BASE_URL = 'https://api.poyo.ai';

// audit#2 M-15: submit/status are quick request/response calls (the actual
// generation runs async and is polled separately via status()) — an endpoint
// that accepts the connection but never responds must not hang the tool call
// forever. 30s is generous for a simple submit/status round trip.
const DEFAULT_TIMEOUT_MS = 30_000;

/** A generated artifact (image/video/…) returned by a finished task. */
export type PoyoFile = {
  url: string;
  type: string;
};

/** Normalised status of a Poyo generation task. */
export type PoyoStatus = {
  /** Poyo lifecycle: not_started | running | finished | failed (passed through verbatim). */
  status: string;
  /** Completion percentage 0–100. */
  progress: number;
  /** Output files — present once the task is `finished`. */
  files: PoyoFile[];
};

export type PoyoClient = {
  /** Submit a generation request. Returns the task id to poll. */
  submit: (model: string, input: Record<string, unknown>) => Promise<string>;
  /** Fetch the current status (and files, when finished) of a task. */
  status: (taskId: string) => Promise<PoyoStatus>;
};

export type PoyoClientOptions = {
  /** Override the API base URL (tests). Defaults to https://api.poyo.ai. */
  baseUrl?: string;
  /** Inject a fetch implementation (tests). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms (audit#2 M-15). Defaults to 30s. */
  timeoutMs?: number;
};

/** Wrap a fetch call so a request that never responds fails loud instead of hanging. */
async function fetchWithTimeout(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new PoyoApiError(
        'poyo_transient',
        `Poyo request to ${url} timed out after ${timeoutMs}ms`,
      );
    }
    throw err;
  }
}

/**
 * Create a thin Poyo client. The API key is captured in the closure and sent
 * as a Bearer token on every request — never logged, never returned.
 */
export function createPoyoClient(accessToken: string, options: PoyoClientOptions = {}): PoyoClient {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const authHeader = { Authorization: `Bearer ${accessToken}` };

  return {
    async submit(model, input) {
      const res = await fetchWithTimeout(
        doFetch,
        `${baseUrl}/api/generate/submit`,
        {
          method: 'POST',
          headers: { ...authHeader, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, input }),
        },
        timeoutMs,
      );
      if (!res.ok) {
        throw mapPoyoHttpError(res.status, await safeText(res));
      }
      const json = (await res.json()) as { data?: { task_id?: unknown }; task_id?: unknown };
      const taskId = json?.data?.task_id ?? json?.task_id;
      if (typeof taskId !== 'string' || taskId.length === 0) {
        throw new PoyoApiError('poyo_unknown', 'Poyo submit response did not include a task_id.');
      }
      return taskId;
    },

    async status(taskId) {
      const res = await fetchWithTimeout(
        doFetch,
        `${baseUrl}/api/generate/status/${encodeURIComponent(taskId)}`,
        {
          method: 'GET',
          headers: { ...authHeader },
        },
        timeoutMs,
      );
      if (!res.ok) {
        throw mapPoyoHttpError(res.status, await safeText(res));
      }
      const json = (await res.json()) as {
        data?: {
          status?: unknown;
          progress?: unknown;
          files?: Array<{ file_url?: unknown; file_type?: unknown }>;
        };
      };
      const data = json?.data ?? {};
      const files: PoyoFile[] = Array.isArray(data.files)
        ? data.files
            .filter((f) => typeof f?.file_url === 'string')
            .map((f) => ({
              url: f.file_url as string,
              type: typeof f.file_type === 'string' ? f.file_type : 'image',
            }))
        : [];
      return {
        status: typeof data.status === 'string' ? data.status : 'unknown',
        progress: typeof data.progress === 'number' ? data.progress : 0,
        files,
      };
    },
  };
}

/** Read a response body as text without throwing (used for error messages). */
async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return `HTTP ${res.status}`;
  }
}

// Re-export error type used by tools
export { PoyoApiError } from './errors.ts';
