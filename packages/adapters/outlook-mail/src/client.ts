// @nodal-agents/adapter-outlook-mail — Microsoft Graph client factory

import { Client, MiddlewareFactory } from '@microsoft/microsoft-graph-client';
import type {
  AuthenticationProvider,
  Context,
  Middleware,
} from '@microsoft/microsoft-graph-client';

// Mirrors adapter-gmail's DEFAULT_TIMEOUT_MS (audit#2026-07-07 F2) — an
// endpoint that accepts the connection but never responds would otherwise
// pend the tool call (and the job) forever.
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * AuthenticationProvider whose token is resolved lazily, once per Graph
 * request. Verified against @microsoft/microsoft-graph-client@3.0.7 source
 * (middleware/AuthenticationHandler.ts, execute()): the SDK's built-in
 * AuthenticationHandler calls `authenticationProvider.getAccessToken()` fresh
 * on EVERY request with no internal caching — unlike adapter-gmail's
 * OAuth2Client, which needed a forced-already-elapsed `expiry_date` hack
 * (see adapter-gmail/src/client.ts) to force re-resolution on every call,
 * this provider needs no such trick: passing the resolver straight through
 * already gives per-request resolution, so a job outliving the ~1h Microsoft
 * token TTL still gets a live token via the runner's advisory-lock refresh
 * path on every underlying request.
 */
export class ResolvedAccessTokenProvider implements AuthenticationProvider {
  constructor(private readonly resolve: () => Promise<string>) {}

  async getAccessToken(): Promise<string> {
    return this.resolve();
  }
}

/**
 * Bounds every individual Graph request — including the SDK's own internal
 * retry/redirect middleware — to `timeoutMs`. A single shared
 * `AbortSignal.timeout()` set once at client construction would fire once
 * from creation time and then incorrectly abort every later request on a
 * client that outlives one call by hours (IDLE_RESET is 4h); starting a
 * fresh `setTimeout` inside `execute()` instead times each Graph API call
 * independently, matching adapter-gmail's per-request gaxios `timeout` option.
 *
 * Review MINOR-2: racing a timeout Promise against `next.execute()` alone
 * only stops US from waiting — the underlying `fetch()` call, buried at the
 * end of the chain in HTTPMessageHandler, keeps running until the OS times
 * out the socket, leaking a connection under sustained load. Verified in the
 * SDK source (middleware/HTTPMessageHandler.ts): it calls
 * `fetch(context.request, context.options)` using the SAME `context.options`
 * object this middleware receives — and `FetchOptions extends RequestInit`,
 * which includes `signal`. Wiring a fresh `AbortController` per call into
 * `context.options.signal` before invoking `next.execute()` lets the timeout
 * actually cancel the in-flight request, not just our wait on it.
 */
export class TimeoutMiddleware implements Middleware {
  private next: Middleware | undefined;

  constructor(private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS) {}

  setNext(next: Middleware): void {
    this.next = next;
  }

  async execute(context: Context): Promise<void> {
    const next = this.next;
    if (!next) {
      throw new Error('TimeoutMiddleware: no next middleware configured (missing setNext)');
    }

    const controller = new AbortController();
    // The default chain never sets its own signal — this always takes over
    // abort control rather than clobbering a caller-supplied one.
    context.options = { ...context.options, signal: controller.signal };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`outlook_request_timeout: request exceeded ${this.timeoutMs}ms`));
      }, this.timeoutMs);
    });
    try {
      await Promise.race([next.execute(context), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * Create a Microsoft Graph client whose access token is resolved lazily —
 * before every request — instead of captured once at construction time.
 * `getAccessToken` is the runner's resolver: it re-reads (and, via its
 * existing advisory-lock refresh path, refreshes) the credential from the DB.
 */
export function createOutlookClient(getAccessToken: () => Promise<string>): Client {
  const authProvider = new ResolvedAccessTokenProvider(getAccessToken);
  const defaultChain = MiddlewareFactory.getDefaultMiddlewareChain(authProvider);
  const timeoutMiddleware = new TimeoutMiddleware(DEFAULT_TIMEOUT_MS);
  return Client.initWithMiddleware({ middleware: [timeoutMiddleware, ...defaultChain] });
}
