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
// its own socket and nothing else. It takes the proxy the environment
// declares (HTTP_PROXY, HTTPS_PROXY, NO_PROXY, read once at start), and leaves
// time to the turn clocks. The agent is ours, not the process-wide
// dispatcher, because which dispatcher the global `fetch` uses depends on LOAD
// ORDER: importing undici 7 installs its own agent as the global one only if
// nothing has touched the bundled `fetch` yet (measured on Node 26.4.0: HTTP/1.1
// in one order, HTTP/2 in the other). Ours holds whatever the order and the
// Node version, in any process that calls a model (runner, conformance CLI,
// the web app's key test, model list and context probe), and leaves every
// other `fetch` of the process as it was. Same shape as the MCP adapter's dedicated agent
// (packages/adapters/mcp/src/client.ts, P0-H7).

import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';

type FetchLike = typeof globalThis.fetch;

/** What undici would otherwise decide for itself, as its own options name it. */
export interface UndiciDefaults {
  headersTimeout?: number;
  bodyTimeout?: number;
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
 * A provider transport on its own agent. `undiciDefaults` stands for the
 * values undici applies when nobody sets them (tests shorten them).
 */
export function createProviderFetch(undiciDefaults: UndiciDefaults = {}): FetchLike {
  const agent = new EnvHttpProxyAgent({
    ...undiciDefaults,
    // HTTP/1.1 only: an unread body can never hold back another call.
    allowH2: false,
    // One authority on time: the turn clocks (turn-clocks.ts), which wait up
    // to 600 s for a first token. undici's own 300 s header and body timeouts
    // would cut a model thinking in silence first, with an error that neither
    // failover nor resume recognises. 0 disables them.
    headersTimeout: 0,
    bodyTimeout: 0,
  });
  return (input, init) => fetchOn(agent, input, init);
}

async function fetchOn(
  agent: EnvHttpProxyAgent,
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
  // undici's Response is the web Response, structurally; the cast only
  // crosses the two copies' type declarations.
  const response = await undiciFetch(url, {
    ...(requestInit as Parameters<typeof undiciFetch>[1]),
    dispatcher: agent,
  });
  return response as unknown as Response;
}

/** The fetch every provider call is given, one agent per process. */
export const providerFetch: FetchLike = createProviderFetch();
