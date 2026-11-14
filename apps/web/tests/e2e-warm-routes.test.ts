// e2e-warm-routes.test.ts — proves the e2e warm-up asks for EVERY page the app
// has, once, and refuses a stack that cannot serve one (#748).
//
// The defect it closes: the e2e stack is `next dev`, which compiles a route on
// its first request, so the first journey to reach an uncompiled route (the
// smoke journey, on `/chat/runs/[id]`) paid the compile inside its own wait and
// failed its first try in every CI run. The warm-up pays it once, up front.
//
// Two layers, each proven on real results: the route list is read from real
// folders (and from the real `src/app`), the warm-up is played against a real
// HTTP server that records what it was asked.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appRoutes, warmRoutes, WARM_ID } from './e2e/warm-routes.ts';

const REAL_APP_DIR = path.join(__dirname, '..', 'src', 'app');

function touch(root: string, rel: string): void {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, 'export default function P() { return null; }\n');
}

describe('appRoutes: the URL of every page, read from the folders', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'warm-routes-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('drops route groups and slots, fills dynamic segments, ignores everything but pages', () => {
    touch(dir, '(dashboard)/page.tsx');
    touch(dir, '(dashboard)/agents/page.tsx');
    touch(dir, '(dashboard)/agents/[id]/edit/page.tsx');
    touch(dir, '(dashboard)/chat/runs/[id]/page.tsx');
    touch(dir, 'docs/[...rest]/page.tsx');
    touch(dir, 'docs/[[...maybe]]/page.tsx');
    touch(dir, 'feed/@modal/page.tsx');
    touch(dir, 'login/page.tsx');
    // Not pages: a route handler (a GET may act on it), a layout, a component.
    touch(dir, 'api/health/route.ts');
    touch(dir, '(dashboard)/layout.tsx');
    touch(dir, '(dashboard)/agents/AgentForm.tsx');

    expect(appRoutes(dir)).toEqual([
      '/',
      '/agents',
      `/agents/${WARM_ID}/edit`,
      `/chat/runs/${WARM_ID}`,
      '/docs/warm',
      '/feed',
      '/login',
    ]);
  });

  it('says each URL once even when two folders lead to it', () => {
    touch(dir, '(a)/same/page.tsx');
    touch(dir, '(b)/same/page.tsx');
    expect(appRoutes(dir)).toEqual(['/same']);
  });

  it('reads the real app: the run page that cost the smoke journey its first try is in it', () => {
    const routes = appRoutes(REAL_APP_DIR);
    expect(routes).toContain('/');
    expect(routes).toContain(`/chat/runs/${WARM_ID}`);
    expect(routes).toContain(`/runs/${WARM_ID}`);
    expect(routes).toContain('/agents');
    // No folder name that is not a URL leaks through.
    expect(routes.filter((r) => /[()@[\]]/.test(r))).toEqual([]);
  });
});

describe('warmRoutes: every route is asked once, with the session, and silence is an error', () => {
  let server: Server;
  let baseURL: string;
  let dir: string;
  let seen: { url: string; cookie: string | undefined }[];
  let handler: (url: string) => { status: number; delayMs?: number; hang?: boolean };

  beforeEach(async () => {
    seen = [];
    handler = () => ({ status: 200 });
    server = createServer((req, res) => {
      seen.push({ url: req.url ?? '', cookie: req.headers.cookie });
      const plan = handler(req.url ?? '');
      if (plan.hang) return; // never answers
      setTimeout(() => {
        res.statusCode = plan.status;
        res.end('x');
      }, plan.delayMs ?? 0);
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = mkdtempSync(path.join(tmpdir(), 'warm-routes-run-'));
    touch(dir, 'app/(g)/page.tsx');
    touch(dir, 'app/(g)/a/page.tsx');
    touch(dir, 'app/(g)/b/[id]/page.tsx');
    touch(dir, 'app/(g)/c/page.tsx');
    writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify({
        cookies: [
          {
            name: 'session',
            value: 'abc',
            domain: '127.0.0.1',
            path: '/',
            expires: -1,
            httpOnly: false,
            secure: false,
            sameSite: 'Lax',
          },
        ],
        origins: [],
      }),
    );
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((ok) => server.close(() => ok()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('asks each page once, sends the saved session, and does not judge the status', async () => {
    handler = (url) => ({ status: url.startsWith('/b/') ? 404 : url === '/c' ? 307 : 200 });
    const report = await warmRoutes({
      baseURL,
      appDir: path.join(dir, 'app'),
      storageState: path.join(dir, 'state.json'),
    });
    expect(seen.map((s) => s.url).sort()).toEqual(['/', '/a', `/b/${WARM_ID}`, '/c']);
    expect(seen.every((s) => s.cookie === 'session=abc')).toBe(true);
    expect(report.routes).toBe(4);
  });

  it('stops the run, naming the route, when a page gives no answer in time', async () => {
    handler = (url) => (url === '/a' ? { status: 200, hang: true } : { status: 200 });
    await expect(
      warmRoutes({
        baseURL,
        appDir: path.join(dir, 'app'),
        storageState: path.join(dir, 'state.json'),
        timeoutMs: 400,
      }),
    ).rejects.toThrow(/Warm-up: \/a gave no answer within 400 ms/);
  });
});
