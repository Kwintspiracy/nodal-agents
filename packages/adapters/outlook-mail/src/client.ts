// @nodal-agents/adapter-outlook-mail — Microsoft Graph client factory

import {
  AuthenticationHandler,
  Client,
  RedirectHandler,
  RedirectHandlerOptions,
  RetryHandler,
  RetryHandlerOptions,
  TelemetryHandler,
} from '@microsoft/microsoft-graph-client';
import type {
  AuthenticationProvider,
  Context,
  FetchOptions,
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
 * The last link of the chain: sends the request through `fetch`, the
 * connector contract's transport (the SDK's own HTTPMessageHandler calls the
 * global `fetch` and takes no other).
 */
export class TransportMiddleware implements Middleware {
  constructor(private readonly send: typeof fetch) {}

  setNext(): void {
    // The last link: nothing follows.
  }

  async execute(context: Context): Promise<void> {
    context.response = await this.send(context.request as RequestInfo, context.options);
  }
}

/** RFC 9110 §9.2.1: methods that cannot have an effect at the provider. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The longest wait the SDK's own retry may make; a longer one goes back to the caller. */
const MAX_SDK_RETRY_WAIT_S = 5;

/**
 * Whether the SDK may retry a request itself: only a safe method (a write it
 * retried after a 503 or a 504 may already have been carried out: the
 * connector contract reports such a write as "outcome unknown" instead), and
 * only for a short wait (a pace refusal with a longer one goes back to the
 * caller as `rate_limited`, with its time).
 */
export function graphMayRetry(
  delaySeconds: number,
  request: RequestInfo,
  options: FetchOptions | undefined,
  response: Response,
): boolean {
  const method = (
    options?.method ?? (typeof request === 'object' ? request.method : 'GET')
  ).toUpperCase();
  if (!SAFE_METHODS.has(method)) return false;
  const header = response.headers.get('retry-after');
  const wait = header !== null && /^\d+$/.test(header) ? Number(header) : delaySeconds;
  return wait <= MAX_SDK_RETRY_WAIT_S;
}

/**
 * Create a Microsoft Graph client whose access token is resolved lazily —
 * before every request — instead of captured once at construction time.
 * `getAccessToken` is the runner's resolver: it re-reads (and, via its
 * existing advisory-lock refresh path, refreshes) the credential from the DB.
 *
 * The chain is the SDK's default one (authentication, retry, redirect,
 * telemetry), with the retry bounded by `graphMayRetry` and the request sent
 * through `transport`: the connector contract's, given by the registry, or
 * the global `fetch`.
 */
export function createOutlookClient(
  getAccessToken: () => Promise<string>,
  transport: typeof fetch = (...args) => fetch(...args),
): Client {
  const authProvider = new ResolvedAccessTokenProvider(getAccessToken);
  const retry = new RetryHandlerOptions(
    // The SDK default delay and number of retries.
    undefined,
    undefined,
    (delay, _attempt, request, options, response) =>
      graphMayRetry(delay, request, options, response),
  );
  return Client.initWithMiddleware({
    middleware: [
      new TimeoutMiddleware(DEFAULT_TIMEOUT_MS),
      new AuthenticationHandler(authProvider),
      new RetryHandler(retry),
      new RedirectHandler(new RedirectHandlerOptions()),
      new TelemetryHandler(),
      new TransportMiddleware(transport),
    ],
  });
}
