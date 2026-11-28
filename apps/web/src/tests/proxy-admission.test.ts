// proxy-admission.test.ts — the dashboard's door, on the REAL proxy (src/proxy.ts).
//
// packages/auth proves the decision (`admitRequest`). This suite proves that
// the dashboard's proxy applies it to every request it can receive:
//
//   1. it runs on every path: no matcher, so a path that looks like a static
//      file reaches it like any other;
//   2. a server action is served only from a page this dashboard serves itself
//      (its Origin is the request's own Host); a foreign Host or Origin is
//      refused, on a dynamic page whose last segment looks like a file too;
//   3. EVERY route handler of the app (the `route.ts` files, enumerated) is
//      under the rule: a foreign page is refused, a body of a type the route
//      does not take is refused, its own page with the right type is served;
//   4. the rule holds in local-auth mode too.
//
// Every request here comes from a browser that has been let in (it carries
// the dashboard cookie), unless it says otherwise: what a browser WITHOUT it
// gets is proxy-launch.test.ts.

import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { dashboardCookieName, mintDashboardCookie } from '@nodal-agents/auth';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NextRequest } from 'next/server';
import * as proxyModule from '../proxy.ts';

const { proxy } = proxyModule;

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');
const OWN = 'http://localhost:3000';

const SECRET = 'install-secret-for-the-proxy-0123456789';

beforeAll(() => {
  process.env['WORKER_SECRET'] = SECRET;
});

afterEach(() => {
  delete process.env['AUTH_MODE'];
});

/** A request as the browser sends it to the dashboard, with the body's framing. */
function request(
  method: string,
  path: string,
  opts: { host?: string; origin?: string; type?: string; body?: string; action?: boolean } = {},
): NextRequest {
  const headers: Record<string, string> = {
    host: opts.host ?? 'localhost:3000',
    // A browser that has been let in through a launch link.
    cookie: `${dashboardCookieName(SECRET)}=${mintDashboardCookie(SECRET, Date.now())}`,
  };
  if (opts.origin !== undefined) headers['origin'] = opts.origin;
  if (opts.action) headers['next-action'] = 'a'.repeat(42);
  let body: Blob | undefined;
  if (opts.body !== undefined) {
    const bytes = new TextEncoder().encode(opts.body);
    body = new Blob([bytes]);
    headers['content-length'] = String(bytes.byteLength);
    if (opts.type !== undefined) headers['content-type'] = opts.type;
  }
  return new NextRequest(`${OWN}${path}`, { method, headers, ...(body ? { body } : {}) });
}

/** What the proxy decided: passed on to Next, or refused with a status and a code. */
async function decide(req: NextRequest): Promise<string> {
  const res = await proxy(req);
  if (res.headers.get('x-middleware-next') === '1') return 'next';
  if (res.status >= 300 && res.status < 400) return `redirect ${res.headers.get('location')}`;
  const body = (await res.json()) as { error?: string };
  return `${res.status} ${String(body.error)}`;
}

// ─── 1–2. Every path, server actions ─────────────────────────────────────────

describe('the dashboard proxy runs on every path @cap:se-connecter/moteur', () => {
  it('exports no matcher: Next runs it on every request', () => {
    expect('config' in proxyModule).toBe(false);
  });

  const LOOKS_STATIC = ['/runs/x.png', '/chat/x.svg', '/agents/x.map', '/logo-128.png'];

  it('a server action posted to a path that looks like a file, with a foreign Host, is refused', async () => {
    for (const path of LOOKS_STATIC) {
      const verdict = await decide(
        request('POST', path, {
          host: 'rebind.example:3000',
          origin: 'http://rebind.example:3000',
          action: true,
          type: 'text/plain;charset=UTF-8',
          body: '[]',
        }),
      );
      expect(verdict, path).toBe('403 host_not_allowed');
    }
  });

  it('a server action from a foreign page is refused, wherever the page lives', async () => {
    for (const origin of [
      'http://localhost:5173',
      'http://localhost',
      'http://127.0.0.1:3000',
      'http://192.168.1.1',
      'https://pages.example',
      'null',
    ]) {
      for (const path of ['/agents', '/runs/x.png']) {
        const verdict = await decide(
          request('POST', path, {
            origin,
            action: true,
            type: 'text/plain;charset=UTF-8',
            body: '[]',
          }),
        );
        expect(verdict, `${origin} ${path}`).toBe('403 origin_not_allowed');
      }
    }
  });

  it('a form posted to a page by a foreign page (no action header) is refused too', async () => {
    const verdict = await decide(
      request('POST', '/agents', {
        origin: 'http://localhost',
        type: 'multipart/form-data; boundary=x',
        body: '--x--',
      }),
    );
    expect(verdict).toBe('403 origin_not_allowed');
  });

  it('a normal server action from the dashboard own page is served', async () => {
    for (const type of ['text/plain;charset=UTF-8', 'multipart/form-data; boundary=x']) {
      const verdict = await decide(
        request('POST', '/agents', { origin: OWN, action: true, type, body: '[]' }),
      );
      expect(verdict, type).toBe('next');
    }
  });

  it('a server action on a LAN address from its own page is served', async () => {
    const verdict = await decide(
      request('POST', '/agents', {
        host: '192.168.1.42:3000',
        origin: 'http://192.168.1.42:3000',
        action: true,
        type: 'text/plain;charset=UTF-8',
        body: '[]',
      }),
    );
    expect(verdict).toBe('next');
  });

  it('a static file is still served, and a page read with no Origin too', async () => {
    expect(await decide(request('GET', '/logo-128.png'))).toBe('next');
    expect(await decide(request('GET', '/_next/static/chunks/main.js'))).toBe('next');
    expect(await decide(request('GET', '/agents'))).toBe('next');
  });
});

// ─── 3. Every route handler ──────────────────────────────────────────────────

interface Handler {
  file: string;
  path: string;
  methods: string[];
}

/** Every `route.ts` of the app, with a concrete path and the methods it exports. */
function routeHandlers(): Handler[] {
  const out: Handler[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__') continue;
        walk(full);
      } else if (entry.name === 'route.ts') {
        const segments = relative(APP_DIR, dirname(full))
          .split(sep)
          .filter((s) => s !== '' && !/^\(.*\)$/.test(s))
          .map((s) => (s.startsWith('[...') ? 'a/b' : s.startsWith('[') ? 'seg-1' : s));
        const text = readFileSync(full, 'utf8');
        const methods = [
          ...text.matchAll(/export (?:async )?function (GET|POST|PUT|PATCH|DELETE)\b/g),
        ].map((m) => m[1]!);
        out.push({ file: relative(APP_DIR, full), path: `/${segments.join('/')}`, methods });
      }
    }
  };
  walk(APP_DIR);
  return out;
}

/** The type a route handler takes in a body, as the browser sends it. */
function ownType(path: string, method: string): string {
  if (method === 'POST' && /^\/api\/voice\/turns\/[^/]+\/chunks\/[^/]+$/.test(path)) {
    return 'application/octet-stream';
  }
  if (method === 'POST' && /^\/api\/oauth\/[^/]+\/start$/.test(path)) {
    return 'application/x-www-form-urlencoded';
  }
  return 'application/json';
}

describe('every route handler of the dashboard is under the rule @cap:se-connecter/moteur', () => {
  const handlers = routeHandlers();
  const nonGet = handlers.flatMap((h) =>
    h.methods.filter((m) => m !== 'GET').map((m) => ({ ...h, method: m })),
  );

  it('the walk finds the route handlers, and non-GET ones among them', () => {
    expect(handlers.length).toBeGreaterThan(15);
    expect(nonGet.length).toBeGreaterThan(10);
    for (const h of handlers) expect(h.methods.length, h.file).toBeGreaterThan(0);
  });

  it('every handler, every method, refuses a foreign page: 403 origin_not_allowed', async () => {
    const wrong: string[] = [];
    for (const h of handlers) {
      for (const method of h.methods) {
        const verdict = await decide(
          request(method, h.path, {
            origin: 'http://localhost:5173',
            ...(method === 'GET' ? {} : { type: ownType(h.path, method), body: '{}' }),
          }),
        );
        if (verdict !== '403 origin_not_allowed') wrong.push(`${method} ${h.path}: ${verdict}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('every non-GET handler refuses a text/plain body from its own page: 415', async () => {
    const wrong: string[] = [];
    for (const h of nonGet) {
      const verdict = await decide(
        request(h.method, h.path, { origin: OWN, type: 'text/plain', body: 'x=1' }),
      );
      if (verdict !== '415 unsupported_media_type') wrong.push(`${h.method} ${h.path}: ${verdict}`);
    }
    expect(wrong).toEqual([]);
  });

  it('every non-GET handler serves its own page sending the type it takes', async () => {
    const wrong: string[] = [];
    for (const h of nonGet) {
      const verdict = await decide(
        request(h.method, h.path, { origin: OWN, type: ownType(h.path, h.method), body: '{}' }),
      );
      if (verdict !== 'next') wrong.push(`${h.method} ${h.path}: ${verdict}`);
    }
    expect(wrong).toEqual([]);
  });

  for (const mode of ['local-trust', 'local-auth'] as const) {
    it(`${mode}: every path refuses a foreign name whose Origin equals its Host, 403 host_not_allowed`, async () => {
      // A foreign name pointed at this machine: Origin and Host agree, so the
      // "own page" rule would let it through. The Host rule refuses it first,
      // on every path: route handlers, pages, paths that look like files.
      process.env['AUTH_MODE'] = mode;
      const paths = [
        ...handlers.flatMap((h) => h.methods.map((m) => ({ method: m, path: h.path }))),
        { method: 'POST', path: '/agents' },
        { method: 'POST', path: '/runs/x.png' },
        { method: 'GET', path: '/agents' },
        { method: 'GET', path: '/logo-128.png' },
        { method: 'GET', path: '/_next/static/chunks/main.js' },
      ];
      const wrong: string[] = [];
      for (const { method, path } of paths) {
        const verdict = await decide(
          request(method, path, {
            host: 'rebind.example:3000',
            origin: 'http://rebind.example:3000',
            ...(method === 'GET'
              ? {}
              : { action: !path.startsWith('/api/'), type: ownType(path, method), body: '{}' }),
          }),
        );
        if (verdict !== '403 host_not_allowed') wrong.push(`${method} ${path}: ${verdict}`);
      }
      expect(wrong).toEqual([]);
    });
  }

  it('a request with no body needs no type (a turn ended, a turn cancelled)', async () => {
    expect(await decide(request('POST', '/api/voice/turns/t-1/end', { origin: OWN }))).toBe('next');
    expect(await decide(request('DELETE', '/api/voice/turns/t-1', { origin: OWN }))).toBe('next');
  });
});

// ─── 4. Sign-in mode ─────────────────────────────────────────────────────────

describe('the rule holds with sign-in on @cap:se-connecter/moteur', () => {
  it('local-auth: a foreign page is refused even with a session cookie; its own page passes', async () => {
    process.env['AUTH_MODE'] = 'local-auth';
    const foreign = request('POST', '/api/chat/stream', {
      origin: 'http://localhost:5173',
      type: 'application/json',
      body: '{}',
    });
    foreign.cookies.set('better-auth.session_token', 'cookie-the-browser-attaches');
    expect(await decide(foreign)).toBe('403 origin_not_allowed');

    const own = request('POST', '/api/chat/stream', {
      origin: OWN,
      type: 'application/json',
      body: '{}',
    });
    own.cookies.set('better-auth.session_token', 'a-session');
    expect(await decide(own)).toBe('next');
  });

  it('local-auth: a page read without a cookie still goes to sign-in, an image does not', async () => {
    process.env['AUTH_MODE'] = 'local-auth';
    expect(await decide(request('GET', '/agents'))).toBe(`redirect ${OWN}/login?next=%2Fagents`);
    expect(await decide(request('GET', '/logo-128.png'))).toBe('next');
  });
});
