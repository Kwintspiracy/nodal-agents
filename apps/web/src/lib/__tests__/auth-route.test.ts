// auth-route.test.ts — the better-auth catch-all must survive the request
// object Next.js actually hands it.
//
// Incident (found 29/08 while trying to run an e2e spec): every /api/auth/*
// call on a LAN install answered 500 —
//
//   TypeError: Cannot read private member #state from an object whose class
//   did not declare it
//       at withStableRateLimitKey (route.ts:43)
//
// — so NOBODY could sign in to the dashboard, since the boot of 26/08, the
// first one after PR #38 merged. That PR fixed a real P0 (the rate limiter
// silently off) by rewriting `x-forwarded-for` through
// `new Request(req, { headers })`. That constructor copies the incoming
// request's private state through a brand check; under Turbopack the request
// is built from a DIFFERENT `Request` realm than the one the route module
// sees, so the brand check throws. No test ever called the route with a
// request of another class, which is why 1 000+ green tests said nothing.
//
// The contract pinned here: the rewrite must (1) set the stable key, (2) keep
// method, url, cookies and body intact — the sign-in POST depends on all four —
// and (3) never rely on copy-constructing the incoming Request.

import { describe, it, expect, vi } from 'vitest';

// The handler is resolved lazily from getBetterAuth(); stub it so the test
// exercises the ROUTE's own request handling, not better-auth.
const seen: Request[] = [];
vi.mock('@/lib/server.ts', () => ({
  getBetterAuth: () => ({
    handler: async (req: Request) => {
      seen.push(req);
      return new Response('ok');
    },
  }),
}));
vi.mock('@nodal-agents/auth', () => ({
  toNextJsHandler: (handler: (req: Request) => Promise<Response>) => ({
    GET: handler,
    POST: handler,
  }),
}));

/**
 * A Request from ANOTHER realm, as Turbopack produces: same shape, but not an
 * `instanceof` of this module's global Request, and with private state the
 * copy-constructor cannot see. Built on a plain object that forwards the Web
 * API surface — exactly what breaks `new Request(req, init)`.
 */
function foreignRequest(url: string, init: RequestInit & { body?: string }): Request {
  const inner = new Request(url, init);
  // A class with its OWN private field mimics the cross-realm brand check:
  // `new Request(foreign, …)` reads `#state` off an object that never declared
  // it and throws the very TypeError seen in production.
  class ForeignRequest {
    #state = 'foreign';
    get url() {
      return inner.url;
    }
    get method() {
      return inner.method;
    }
    get headers() {
      return inner.headers;
    }
    get body() {
      return inner.body;
    }
    get signal() {
      return inner.signal;
    }
    text() {
      return inner.text();
    }
    get [Symbol.toStringTag]() {
      return this.#state === 'foreign' ? 'Request' : 'Request';
    }
  }
  return new ForeignRequest() as unknown as Request;
}

describe('/api/auth/[...all] — request rewrite', () => {
  it('handles a Request from another realm (the Turbopack case) instead of throwing', async () => {
    const { GET } = await import('../../app/api/auth/[...all]/route.ts');
    const req = foreignRequest('http://localhost:3000/api/auth/session', {
      method: 'GET',
      headers: { cookie: 'better-auth.session_token=abc', 'x-forwarded-for': '203.0.113.9' },
    });

    const res = await GET(req);

    expect(res.status).toBe(200);
  });

  it('pins the rate-limit key AND keeps method, url, cookies and body', async () => {
    seen.length = 0;
    const { POST } = await import('../../app/api/auth/[...all]/route.ts');
    const req = foreignRequest('http://localhost:3000/api/auth/sign-in/email?cb=1', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: 'a=b',
        // A client-supplied value must NOT survive: varying it would let a
        // caller dodge the per-key cap, which is what PR #38 closed.
        'x-forwarded-for': '203.0.113.9',
      },
      body: JSON.stringify({ email: 'x@y', password: 'p' }),
    });

    await POST(req);

    expect(seen).toHaveLength(1);
    const forwarded = seen[0]!;
    expect(forwarded.headers.get('x-forwarded-for')).toBe('127.0.0.1');
    expect(forwarded.method).toBe('POST');
    expect(forwarded.url).toBe('http://localhost:3000/api/auth/sign-in/email?cb=1');
    expect(forwarded.headers.get('cookie')).toBe('a=b');
    expect(await forwarded.text()).toBe(JSON.stringify({ email: 'x@y', password: 'p' }));
  });
});
