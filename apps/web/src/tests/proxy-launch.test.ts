// proxy-launch.test.ts — how a browser enters the dashboard in the mode with no
// password, on the REAL proxy (src/proxy.ts).
//
//   1. without the cookie, every path (a page, a server action, every route
//      handler, a static file) answers the page that says how to get the link
//      again: never a blank error, never the dashboard;
//   2. the launch link sets the cookie (HttpOnly, SameSite=Strict, bound to
//      this install, long-lived), is consumed by its first use, and the
//      address bar is cleaned by a redirect;
//   3. with the cookie, the dashboard is served; a cookie of another install
//      is not one;
//   4. a program of the install is served with the install's secret;
//   5. a navigation from another site, which carries no Strict cookie, is
//      opened once more from here;
//   6. the modes with a sign-in keep their own proof: no launch link there;
//   7. no launch link is ever written to the dev server's request log.

import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NextRequest } from 'next/server';
import {
  DASHBOARD_COOKIE_MAX_AGE_S,
  LAUNCH_PARAM,
  LAUNCH_TTL_MS,
  dashboardCookieName,
  launchUrl,
  mintDashboardCookie,
  mintLaunchToken,
} from '@nodal-agents/auth';
import { proxy } from '../proxy.ts';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');
const OWN = 'http://localhost:3000';
const SECRET = 'install-secret-of-this-dashboard-0123456789'; // secrets:allow (a test fixture, not a credential)
const OTHER_INSTALL = 'install-secret-of-another-install-98765';

beforeAll(() => {
  process.env['WORKER_SECRET'] = SECRET;
});

afterEach(() => {
  delete process.env['AUTH_MODE'];
  process.env['WORKER_SECRET'] = SECRET;
});

interface Opts {
  origin?: string;
  cookie?: string;
  authorization?: string;
  action?: boolean;
  type?: string;
  body?: string;
  fetchSite?: string;
  fetchMode?: string;
}

function request(method: string, pathAndQuery: string, opts: Opts = {}): NextRequest {
  const headers: Record<string, string> = { host: 'localhost:3000' };
  if (opts.origin !== undefined) headers['origin'] = opts.origin;
  if (opts.cookie !== undefined) headers['cookie'] = opts.cookie;
  if (opts.authorization !== undefined) headers['authorization'] = opts.authorization;
  if (opts.action) headers['next-action'] = 'a'.repeat(42);
  if (opts.fetchSite !== undefined) headers['sec-fetch-site'] = opts.fetchSite;
  if (opts.fetchMode !== undefined) headers['sec-fetch-mode'] = opts.fetchMode;
  let body: Blob | undefined;
  if (opts.body !== undefined) {
    const bytes = new TextEncoder().encode(opts.body);
    body = new Blob([bytes]);
    headers['content-length'] = String(bytes.byteLength);
    if (opts.type !== undefined) headers['content-type'] = opts.type;
  }
  return new NextRequest(`${OWN}${pathAndQuery}`, { method, headers, ...(body ? { body } : {}) });
}

function cookieOf(secret: string, issuedAt = Date.now()): string {
  return `${dashboardCookieName(secret)}=${mintDashboardCookie(secret, issuedAt)}`;
}

/** What the proxy decided, in one line. */
async function decide(req: NextRequest): Promise<string> {
  const res = await proxy(req);
  if (res.headers.get('x-middleware-next') === '1') return 'next';
  const type = res.headers.get('content-type') ?? '';
  if (type.startsWith('text/html')) {
    const html = await res.text();
    // The page names the reason, and the command that gets the link again.
    expect(html).toContain('nodal-agents open');
    expect(html).toContain(`data-reason="${res.headers.get('x-nodal-refusal')}"`);
    return `${res.status} page ${res.headers.get('x-nodal-refusal')}`;
  }
  if (res.status >= 300 && res.status < 400) return `redirect ${res.headers.get('location')}`;
  const body = (await res.json()) as { error?: string };
  return `${res.status} ${String(body.error)}`;
}

/** Every `route.ts` of the app, with a concrete path and the methods it exports. */
function routeHandlers(): { path: string; methods: string[] }[] {
  const out: { path: string; methods: string[] }[] = [];
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
        const methods = [
          ...readFileSync(full, 'utf8').matchAll(
            /export (?:async )?function (GET|POST|PUT|PATCH|DELETE)\b/g,
          ),
        ].map((m) => m[1]!);
        out.push({ path: `/${segments.join('/')}`, methods });
      }
    }
  };
  walk(APP_DIR);
  return out;
}

function ownType(path: string, method: string): string {
  if (method === 'POST' && /^\/api\/voice\/turns\/[^/]+\/chunks\/[^/]+$/.test(path)) {
    return 'application/octet-stream';
  }
  if (method === 'POST' && /^\/api\/oauth\/[^/]+\/start$/.test(path)) {
    return 'application/x-www-form-urlencoded';
  }
  return 'application/json';
}

// ─── 1. Without the cookie ───────────────────────────────────────────────────

describe('a browser without the cookie gets the page that says how to get the link @cap:se-connecter/moteur', () => {
  it('a page route, a server action, a static file: the page, 401 proof_required', async () => {
    expect(await decide(request('GET', '/agents'))).toBe('401 page proof_required');
    expect(await decide(request('GET', '/'))).toBe('401 page proof_required');
    expect(
      await decide(
        request('POST', '/agents', {
          origin: OWN,
          action: true,
          type: 'text/plain;charset=UTF-8',
          body: '[]',
        }),
      ),
    ).toBe('401 page proof_required');
    expect(await decide(request('GET', '/logo-128.png'))).toBe('401 page proof_required');
    expect(await decide(request('GET', '/_next/static/chunks/main.js'))).toBe(
      '401 page proof_required',
    );
  });

  it('every route handler, every method, from its own page: the page', async () => {
    const handlers = routeHandlers();
    expect(handlers.length).toBeGreaterThan(15);
    const wrong: string[] = [];
    for (const h of handlers) {
      for (const method of h.methods) {
        const verdict = await decide(
          request(method, h.path, {
            origin: OWN,
            ...(method === 'GET' ? {} : { type: ownType(h.path, method), body: '{}' }),
          }),
        );
        if (verdict !== '401 page proof_required') wrong.push(`${method} ${h.path}: ${verdict}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('a second browser profile, with the cookie of ANOTHER install: the page, proof_invalid', async () => {
    expect(await decide(request('GET', '/agents', { cookie: cookieOf(OTHER_INSTALL) }))).toBe(
      '401 page proof_required',
    );
    // The same cookie name with a value another secret signed: presented, not held.
    const forged = `${dashboardCookieName(SECRET)}=${mintDashboardCookie(OTHER_INSTALL, Date.now())}`;
    expect(await decide(request('GET', '/agents', { cookie: forged }))).toBe(
      '401 page proof_invalid',
    );
  });

  it('a cookie older than its 400 days is not one', async () => {
    const old = cookieOf(SECRET, Date.now() - DASHBOARD_COOKIE_MAX_AGE_S * 1000 - 60_000);
    expect(await decide(request('GET', '/agents', { cookie: old }))).toBe('401 page proof_invalid');
  });

  it('the refusal never says more than its reason: no secret, no cookie value in the page', async () => {
    const res = await proxy(request('GET', '/agents', { cookie: cookieOf(OTHER_INSTALL) }));
    const html = await res.text();
    expect(html).not.toContain(SECRET);
    expect(html).not.toContain(OTHER_INSTALL);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

// ─── 2. The launch link ──────────────────────────────────────────────────────

describe('the launch link lets one browser in, once @cap:se-connecter/moteur', () => {
  it('sets the cookie, cleans the address by a redirect, and is refused the second time', async () => {
    const link = new URL(launchUrl(`${OWN}/agents?tab=runs`, SECRET));
    const first = await proxy(request('GET', `${link.pathname}${link.search}`));
    expect(first.status).toBe(303);
    // The address bar keeps everything but the one-time value.
    const location = new URL(first.headers.get('location') ?? '', OWN);
    expect(`${location.origin}${location.pathname}${location.search}`).toBe(
      `${OWN}/agents?tab=runs`,
    );
    const setCookie = first.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${dashboardCookieName(SECRET)}=`);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).toContain(`Max-Age=${DASHBOARD_COOKIE_MAX_AGE_S}`);
    // Not over http: a Secure cookie would never come back from localhost on a LAN.
    expect(setCookie).not.toMatch(/Secure/i);
    expect(first.headers.get('referrer-policy')).toBe('no-referrer');

    // The cookie it set is the browser's proof from now on.
    const value = /=([^;]+)/.exec(setCookie)![1]!;
    expect(
      await decide(
        request('GET', '/agents', { cookie: `${dashboardCookieName(SECRET)}=${value}` }),
      ),
    ).toBe('next');

    // The same link again: used.
    expect(await decide(request('GET', `${link.pathname}${link.search}`))).toBe(
      '401 page launch_used',
    );
  });

  it('an expired link, a link of another install, a broken link: the page with its reason', async () => {
    const expired = mintLaunchToken(SECRET, Date.now() - LAUNCH_TTL_MS - 1);
    expect(await decide(request('GET', `/?${LAUNCH_PARAM}=${expired}`))).toBe(
      '401 page launch_expired',
    );
    const foreign = mintLaunchToken(OTHER_INSTALL, Date.now());
    expect(await decide(request('GET', `/?${LAUNCH_PARAM}=${foreign}`))).toBe(
      '401 page launch_invalid',
    );
    expect(await decide(request('GET', `/?${LAUNCH_PARAM}=abc`))).toBe('401 page launch_malformed');
  });

  it('a link is no proof for a name that does not mean this machine', async () => {
    const token = mintLaunchToken(SECRET, Date.now());
    const req = new NextRequest(`http://rebind.example:3000/?${LAUNCH_PARAM}=${token}`, {
      headers: { host: 'rebind.example:3000' },
    });
    expect(await decide(req)).toBe('403 host_not_allowed');
  });

  it('a link only works as a navigation: a POST that carries one is judged without it', async () => {
    const token = mintLaunchToken(SECRET, Date.now());
    expect(
      await decide(
        request('POST', `/agents?${LAUNCH_PARAM}=${token}`, {
          origin: OWN,
          action: true,
          type: 'text/plain',
          body: '[]',
        }),
      ),
    ).toBe('401 page proof_required');
  });
});

// ─── 3–4. With the cookie, or the install's secret ───────────────────────────

describe('with its proof, the dashboard is served @cap:se-connecter/moteur', () => {
  it('the cookie serves a page and a server action from its own page', async () => {
    const cookie = cookieOf(SECRET);
    expect(await decide(request('GET', '/agents', { cookie }))).toBe('next');
    expect(
      await decide(
        request('POST', '/agents', {
          cookie,
          origin: OWN,
          action: true,
          type: 'text/plain;charset=UTF-8',
          body: '[]',
        }),
      ),
    ).toBe('next');
  });

  it('the cookie never lets a foreign page in', async () => {
    expect(
      await decide(
        request('POST', '/agents', {
          cookie: cookieOf(SECRET),
          origin: 'http://localhost:5173',
          action: true,
          type: 'text/plain;charset=UTF-8',
          body: '[]',
        }),
      ),
    ).toBe('403 origin_not_allowed');
  });

  it("a program of this install is served with the install's secret; a wrong one is refused", async () => {
    expect(await decide(request('GET', '/api/health', { authorization: `Bearer ${SECRET}` }))).toBe(
      'next',
    );
    expect(await decide(request('GET', '/', { authorization: `Bearer ${SECRET}` }))).toBe('next');
    expect(
      await decide(request('GET', '/api/health', { authorization: `Bearer ${OTHER_INSTALL}` })),
    ).toBe('401 page proof_invalid');
  });

  it('a dashboard started without the install secret serves nobody, and says why', async () => {
    process.env['WORKER_SECRET'] = '';
    expect(await decide(request('GET', '/agents', { cookie: cookieOf(SECRET) }))).toBe(
      '500 install_secret_missing',
    );
  });
});

// ─── 5. A navigation from another site ───────────────────────────────────────

describe('a navigation from another site is opened once more from here @cap:se-connecter/moteur', () => {
  it('cross-site, no cookie: the page asks the browser to open the address again', async () => {
    const res = await proxy(
      request('GET', '/api/oauth/google-oauth/callback?code=c&state=s', {
        fetchSite: 'cross-site',
        fetchMode: 'navigate',
      }),
    );
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('location.replace(location.href)');
  });

  it('the second navigation is same-origin: never asked again, so never a loop', async () => {
    for (const fetchSite of ['same-origin', 'none', 'same-site']) {
      const res = await proxy(request('GET', '/agents', { fetchSite, fetchMode: 'navigate' }));
      expect(await res.text(), fetchSite).not.toContain('location.replace');
    }
  });
});

// ─── 6. The modes with a sign-in ─────────────────────────────────────────────

describe('the modes with a sign-in keep their own proof @cap:se-connecter/moteur', () => {
  for (const mode of ['local-auth', 'bearer-token'] as const) {
    it(`${mode}: no launch link, no cookie of ours; a page without a session goes to sign-in`, async () => {
      process.env['AUTH_MODE'] = mode;
      expect(await decide(request('GET', '/agents'))).toBe(`redirect ${OWN}/login?next=%2Fagents`);
      const token = mintLaunchToken(SECRET, Date.now());
      const res = await proxy(request('GET', `/agents?${LAUNCH_PARAM}=${token}`));
      expect(res.headers.get('set-cookie') ?? '').not.toContain(dashboardCookieName(SECRET));
      // The login page and the health probe stay reachable without a session.
      expect(await decide(request('GET', '/login'))).toBe('next');
      expect(await decide(request('GET', '/api/health'))).toBe('next');
    });
  }
});

// ─── 7. Never in a log ───────────────────────────────────────────────────────

describe('a launch link is never written to the request log @cap:se-connecter/moteur', () => {
  it("next.config's ignore list matches every launch link, and no other address", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'next.config.ts'),
      'utf8',
    );
    const literal = /incomingRequests:\s*\{\s*ignore:\s*\[\s*\/(.+?)\/\s*\]/.exec(source)?.[1];
    expect(literal).toBeDefined();
    const ignore = new RegExp(literal!);
    for (const base of [`${OWN}/`, `${OWN}/agents?tab=x`, 'http://127.0.0.1:4320/bench-studio']) {
      const url = new URL(launchUrl(base, SECRET));
      expect(ignore.test(`${url.pathname}${url.search}`), base).toBe(true);
    }
    expect(ignore.test('/agents?tab=x')).toBe(false);
  });
});
