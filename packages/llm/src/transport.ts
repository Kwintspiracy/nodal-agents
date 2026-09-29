// @nodal-agents/llm — the one transport of every provider call (#608)
//
// Node 26's global `fetch` (bundled undici 8) negotiates HTTP/2 with the
// hosted providers, and every call of the process then rides ONE connection
// per origin. A response body nobody reads keeps its stream open on that
// connection, and the provider holds the connection's other calls behind it
// (Node's client itself credits the connection window of a paused stream: the
// hold is the server's). The runner makes every call of every job, chat turn
// and title in one process: on 2026-09-29 every model call of every user took
// minutes, while the same requests from another process answered in seconds.
//
// Every provider call of this package therefore goes through `providerFetch`:
// undici's own `fetch` on a dedicated agent that speaks HTTP/1.1 only. Calls
// in flight at the same time get a socket each, so a body left unread holds
// its own socket and nothing else. Hosted providers are reached through the
// proxy the environment declares; a model on the user's machine or network
// directly. Time belongs to the caller's deadline, or to a bounded default
// when it brings none. The dispatcher is ours, not the process-wide
// dispatcher, because which dispatcher the global `fetch` uses depends on LOAD
// ORDER: importing undici 7 installs its own agent as the global one only if
// nothing has touched the bundled `fetch` yet (measured on Node 26.4.0: HTTP/1.1
// in one order, HTTP/2 in the other). Ours holds whatever the order and the
// Node version, in any process that calls a model (runner, conformance CLI,
// the web app's key test, model list and context probe), and leaves every
// other `fetch` of the process as it was. Same shape as the MCP adapter's
// dedicated agent (packages/adapters/mcp/src/client.ts, P0-H7).

import { Agent, Dispatcher, EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';

import { isLocalUrl } from './local-url';

type FetchLike = typeof globalThis.fetch;

/** What undici would otherwise decide for itself, as its own options name it. */
export interface UndiciDefaults {
  headersTimeout?: number;
  bodyTimeout?: number;
}

/**
 * The deadline of a provider call that brings none of its own: 300 s, like
 * the one-shot call budget (client.ts `LLM_TIMEOUT_MS`). Override with
 * `NODAL_PROVIDER_CALL_TIMEOUT_MS`.
 */
export const DEFAULT_PROVIDER_CALL_TIMEOUT_MS = 300_000;

function defaultCallTimeoutMs(): number {
  const raw = Number(process.env['NODAL_PROVIDER_CALL_TIMEOUT_MS']);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PROVIDER_CALL_TIMEOUT_MS;
}

/**
 * Where a request goes, decided per origin, redirects included: a model on
 * the user's machine or network (`isLocalUrl`, the definition the turn clocks
 * use) directly, since no proxy can reach it; every other host the way the
 * environment says (HTTP_PROXY, HTTPS_PROXY, NO_PROXY, read once at start).
 */
class ProviderDispatcher extends Dispatcher {
  constructor(
    private readonly direct: Agent,
    private readonly viaEnvironment: EnvHttpProxyAgent,
  ) {
    super();
  }

  override dispatch(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler,
  ): boolean {
    const target = isLocalUrl(String(options.origin)) ? this.direct : this.viaEnvironment;
    return target.dispatch(options, handler);
  }

  override close(): Promise<void>;
  override close(callback: () => void): void;
  override close(callback?: () => void): Promise<void> | void {
    const done = Promise.all([this.direct.close(), this.viaEnvironment.close()]).then(() => {});
    if (callback) void done.then(callback);
    else return done;
  }

  override destroy(): Promise<void>;
  override destroy(err: Error | null): Promise<void>;
  override destroy(callback: () => void): void;
  override destroy(err: Error | null, callback: () => void): void;
  override destroy(
    errOrCallback?: Error | null | (() => void),
    callback?: () => void,
  ): Promise<void> | void {
    const err = typeof errOrCallback === 'function' ? null : (errOrCallback ?? null);
    const cb = typeof errOrCallback === 'function' ? errOrCallback : callback;
    const done = Promise.all([this.direct.destroy(err), this.viaEnvironment.destroy(err)]).then(
      () => {},
    );
    if (cb) void done.then(cb);
    else return done;
  }
}

/**
 * A body undici's `fetch` takes as it is. Anything else (a global `FormData`
 * or `Blob` from another undici copy, a stream) is serialised through a
 * global Request first, which also yields its content type.
 */
function isPlainBody(body: unknown): boolean {
  return (
    body === undefined ||
    body === null ||
    typeof body === 'string' ||
    body instanceof Uint8Array ||
    body instanceof ArrayBuffer ||
    body instanceof URLSearchParams
  );
}

function urlOf(input: Parameters<FetchLike>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  // A Request object would carry its own method, headers and body, which the
  // callers of this transport never build: refused rather than half-copied.
  throw new TypeError('providerFetch takes a URL string or URL, not a Request object');
}

/**
 * A provider transport on its own dispatcher. `undiciDefaults` stands for the
 * values undici applies when nobody sets them, `callTimeoutMs` for the
 * default deadline (tests shorten both).
 */
export function createProviderFetch(
  opts: { undiciDefaults?: UndiciDefaults; callTimeoutMs?: number } = {},
): FetchLike {
  const agentOptions = {
    ...opts.undiciDefaults,
    // HTTP/1.1 only: an unread body can never hold back another call.
    allowH2: false,
    // undici's own 300 s header and body timeouts never apply: a call's
    // deadline is its caller's (the turn clocks wait up to 600 s for a first
    // token), or the default one below. 0 disables them.
    headersTimeout: 0,
    bodyTimeout: 0,
  };
  const dispatcher = new ProviderDispatcher(
    new Agent(agentOptions),
    new EnvHttpProxyAgent(agentOptions),
  );
  const callTimeoutMs = opts.callTimeoutMs ?? defaultCallTimeoutMs();
  return (input, init) => fetchOn(dispatcher, callTimeoutMs, input, init);
}

async function fetchOn(
  dispatcher: Dispatcher,
  callTimeoutMs: number,
  input: Parameters<FetchLike>[0],
  init: Parameters<FetchLike>[1],
): Promise<Response> {
  const url = urlOf(input);
  let requestInit: RequestInit = init ?? {};
  if (!isPlainBody(requestInit.body)) {
    const serialised = new Request(url, { ...requestInit, duplex: 'half' } as RequestInit);
    requestInit = {
      ...requestInit,
      headers: serialised.headers,
      body: new Uint8Array(await serialised.arrayBuffer()),
    };
  }
  // One authority on time. A call that brings a signal is governed by it
  // alone: the turn clocks, the stale retry's timeout, a Stop. One that
  // brings none (a key test, an embedding, speech, an image) gets the default
  // deadline, so no provider call can hang for ever. It covers the body too.
  const deadline = requestInit.signal == null ? AbortSignal.timeout(callTimeoutMs) : undefined;
  try {
    // undici's Response is the web Response, structurally; the cast only
    // crosses the two copies' type declarations.
    const response = await undiciFetch(url, {
      ...(requestInit as Parameters<typeof undiciFetch>[1]),
      ...(deadline ? { signal: deadline } : {}),
      dispatcher,
    });
    return response as unknown as Response;
  } catch (err) {
    if (deadline?.aborted) {
      const timeout = new Error(
        `provider call to ${new URL(url).origin} got no answer within ${callTimeoutMs} ms (no deadline was given by the caller)`,
        { cause: err },
      );
      timeout.name = 'TimeoutError';
      throw timeout;
    }
    throw err;
  }
}

/** The fetch every provider call is given, one dispatcher per process. */
export const providerFetch: FetchLike = createProviderFetch();
