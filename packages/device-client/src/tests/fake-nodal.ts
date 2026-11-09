// fake-nodal.ts — a scripted Nodal for the client's unit tests.
//
// It answers `fetch` like the runner does at its boundary (status, JSON or an
// SSE body that the test writes to as it goes), and records every request as
// the runner would receive it: method, path, headers, body. The tests assert
// on those requests and on what the client emits, never on call counts.

export interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  bytes: Uint8Array | null;
}

/** An SSE body the test writes to: `send(event, data, id?)`, `ping()`, `drop()`, `end()`. */
export interface LiveStream {
  response: Response;
  send(event: string, data: unknown, id?: string): void;
  raw(text: string): void;
  ping(): void;
  /** The network fails mid-stream. */
  drop(): void;
  /** The server closes the stream. */
  end(): void;
  readonly closed: boolean;
}

/** A live body aborts with its request, as a real `fetch` body does. */
const aborters = new WeakMap<Response, () => void>();

export function liveStream(): LiveStream {
  const enc = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      closed = true;
    },
  });
  const write = (s: string): void => {
    if (!closed) controller.enqueue(enc.encode(s));
  };
  const response = new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
  aborters.set(response, () => {
    if (closed) return;
    closed = true;
    controller.error(new DOMException('aborted', 'AbortError'));
  });
  return {
    response,
    send(event, data, id) {
      write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    raw: write,
    ping() {
      write(': ping\n\n');
    },
    drop() {
      if (closed) return;
      closed = true;
      controller.error(new TypeError('network error'));
    },
    end() {
      if (closed) return;
      closed = true;
      controller.close();
    },
    get closed() {
      return closed;
    },
  };
}

/** A finished SSE body: every event at once. */
export function sseBody(events: Array<[string, unknown]>): Response {
  const text = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

export type Route = (
  req: Recorded,
  signal: AbortSignal | undefined,
) => Response | Promise<Response>;

export function fakeNodal(routes: Record<string, Route>) {
  const requests: Recorded[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    let body: unknown = null;
    let bytes: Uint8Array | null = null;
    if (init?.body instanceof Uint8Array) bytes = new Uint8Array(init.body);
    else if (typeof init?.body === 'string') body = JSON.parse(init.body);
    const rec: Recorded = { method, path: url.pathname + url.search, headers, body, bytes };
    requests.push(rec);
    const key = Object.keys(routes).find((k) => {
      const [m, p] = k.split(' ');
      const re = new RegExp(`^${p!.replace(/:[A-Za-z]+/g, '[^/?]+')}(\\?.*)?$`);
      return m === method && re.test(rec.path);
    });
    if (!key) return Response.json({ error: 'not_found' }, { status: 404 });
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const res = await routes[key]!(rec, init?.signal ?? undefined);
    const abort = aborters.get(res);
    if (abort) init?.signal?.addEventListener('abort', abort, { once: true });
    return res;
  }) as typeof fetch;
  return { fetch: fetchImpl, requests };
}

/** Resolves once `predicate` holds, polling the event loop. */
export async function until(predicate: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}
