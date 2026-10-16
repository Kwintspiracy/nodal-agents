// bench-studio.test.mjs — Bench Studio ne sert que cette machine, ne touche pas la stack, ne part jamais dans un build.
//
// Trois promesses, chacune prouvée ici sur le vrai code du serveur et de la
// vérification de build (scripts/lib/bench-studio.mjs, bench-studio-absent.mjs) :
//   1. rien du studio ne sort d'un build ordinaire ni du pack ;
//   2. son point de lancement n'est joignable que depuis la boucle locale,
//      même quand la stack tourne en mode LAN, et seulement par ses propres
//      pages : une autre page du navigateur ne peut rien y lancer (CSRF), et ce
//      port ne sert que Bench Studio ;
//   3. il ne prend ni le port ni le dossier de build de la stack.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer as createNetServer, connect } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  STUDIO_CSRF_HEADER,
  STUDIO_DIST_DIR,
  STUDIO_GATE_HEADER,
  STUDIO_HOST,
  STUDIO_PORT,
  assertStudioPort,
  createStudioServer,
  keepFile,
  listenLoopback,
  studioEnv,
  studioRefusal,
} from '../lib/bench-studio.mjs';
import { findStudioTraces } from '../lib/bench-studio-absent.mjs';
import { portsDeLaStack } from '../lib/live-stack.mjs';

const GATE = 'g'.repeat(48);
const CSRF = 'c'.repeat(48);

function freePort() {
  return new Promise((resolve) => {
    const s = createNetServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function send(
  port,
  { host, method = 'GET', path = '/bench-studio/api/launch', headers = {}, body },
) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method, path, headers: { host, ...headers } },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, body: text, headers: res.headers }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const get = (port, host, headers = {}) =>
  send(port, { host, headers }).then(({ status, body }) => ({ status, body }));

/** Un serveur de studio réel, devant un faux Next qui note chaque requête qui l'atteint. */
async function studio() {
  const port = await freePort();
  const reached = [];
  const server = createStudioServer({
    port,
    gate: GATE,
    csrf: CSRF,
    handle: (req, res) => {
      reached.push({
        method: req.method,
        url: req.url,
        gate: req.headers[STUDIO_GATE_HEADER],
        csrf: req.headers[STUDIO_CSRF_HEADER],
      });
      res.end('next');
    },
    upgrade: () => undefined,
  });
  servers.push(server);
  await listenLoopback(server, port);
  return { port, reached, own: `http://127.0.0.1:${port}` };
}

const servers = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

describe('Bench Studio serves this machine only', () => {
  it('admits a loopback address with a loopback Host on its own port, and nothing else', () => {
    for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1'])
      for (const host of ['127.0.0.1:4320', 'localhost:4320', '[::1]:4320', 'LOCALHOST:4320'])
        expect(studioRefusal({ remoteAddress, host }, 4320)).toBeNull();
    // Depuis le réseau : refusé, quel que soit le Host annoncé.
    expect(studioRefusal({ remoteAddress: '192.168.1.20', host: '127.0.0.1:4320' }, 4320)).toBe(
      'studio_not_loopback',
    );
    expect(studioRefusal({ remoteAddress: undefined, host: '127.0.0.1:4320' }, 4320)).toBe(
      'studio_not_loopback',
    );
    // Rebinding DNS : la bonne adresse, un nom qui n'est pas cette machine.
    expect(studioRefusal({ remoteAddress: '127.0.0.1', host: 'evil.test:4320' }, 4320)).toBe(
      'studio_host_not_allowed',
    );
    expect(studioRefusal({ remoteAddress: '127.0.0.1', host: 'localhost.evil.test' }, 4320)).toBe(
      'studio_host_not_allowed',
    );
    expect(studioRefusal({ remoteAddress: '127.0.0.1', host: '127.0.0.1:3000' }, 4320)).toBe(
      'studio_host_not_allowed',
    );
    expect(studioRefusal({ remoteAddress: '127.0.0.1', host: undefined }, 4320)).toBe(
      'studio_host_not_allowed',
    );
  });

  it('the real server listens on 127.0.0.1 only, filters before Next, and stamps its own gate token', async () => {
    const port = await freePort();
    const seen = [];
    const server = createStudioServer({
      port,
      gate: GATE,
      csrf: CSRF,
      handle: (req, res) => {
        seen.push(req.headers[STUDIO_GATE_HEADER]);
        res.end('next');
      },
      upgrade: () => undefined,
    });
    servers.push(server);
    const addr = await listenLoopback(server, port);
    expect(addr).toMatchObject({ address: STUDIO_HOST, port });

    expect(await get(port, 'evil.test')).toEqual({
      status: 403,
      body: JSON.stringify({ error: 'studio_host_not_allowed' }),
    });
    expect(seen).toEqual([]);
    // Un jeton envoyé par le client ne passe jamais : celui du serveur l'écrase.
    expect(await get(port, `127.0.0.1:${port}`, { [STUDIO_GATE_HEADER]: 'forged' })).toEqual({
      status: 200,
      body: 'next',
    });
    expect(seen).toEqual([GATE]);
  });

  const lan = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

  it.skipIf(!lan)('from a LAN address of this machine, nothing answers at all', async () => {
    const port = await freePort();
    const server = createStudioServer({
      port,
      gate: GATE,
      csrf: CSRF,
      handle: (_q, s) => s.end(),
      upgrade: () => undefined,
    });
    servers.push(server);
    await listenLoopback(server, port);
    const code = await new Promise((resolve) => {
      const sock = connect({ host: lan, port });
      sock.on('connect', () => {
        sock.destroy();
        resolve('connected');
      });
      sock.on('error', (e) => resolve(e.code));
    });
    expect(code).toBe('ECONNREFUSED');
  });

  it('a busy port fails loud, never falls back to another one', async () => {
    const port = await freePort();
    const first = createStudioServer({
      port,
      gate: GATE,
      csrf: CSRF,
      handle: () => undefined,
      upgrade: () => undefined,
    });
    servers.push(first);
    await listenLoopback(first, port);
    const second = createStudioServer({
      port,
      gate: GATE,
      csrf: CSRF,
      handle: () => undefined,
      upgrade: () => undefined,
    });
    await expect(listenLoopback(second, port)).rejects.toThrow(
      `bench_studio_port_busy: 127.0.0.1:${port} is already in use`,
    );
  });
});

describe('only the studio pages can change anything (CSRF)', () => {
  // Ce qu'une page malveillante ouverte dans le navigateur du propriétaire peut
  // envoyer sans pré-vol CORS : un POST `no-cors` en text/plain.
  const noCors = (origin) => ({
    origin,
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'no-cors',
    'content-type': 'text/plain;charset=UTF-8',
  });
  const launchBody = JSON.stringify({ selection: { only: ['question'] }, trials: 1 });

  for (const path of ['/bench-studio/api/launch', '/bench-studio/api/runs/run-1-1/cancel']) {
    it(`a no-cors text/plain POST from another site to ${path} is refused before Next`, async () => {
      const { port, reached } = await studio();
      for (const origin of ['http://evil.test', `http://localhost:3000`, 'null']) {
        const r = await send(port, {
          host: `127.0.0.1:${port}`,
          method: 'POST',
          path,
          headers: noCors(origin),
          body: launchBody,
        });
        expect(r).toMatchObject({
          status: 403,
          body: JSON.stringify({ error: 'studio_foreign_origin' }),
        });
      }
      // Sans Origin (un navigateur qui l'omettrait), Sec-Fetch-Site suffit à refuser.
      const r = await send(port, {
        host: `127.0.0.1:${port}`,
        method: 'POST',
        path,
        headers: { 'sec-fetch-site': 'same-site', 'content-type': 'text/plain' },
        body: launchBody,
      });
      expect(r.status).toBe(403);
      expect(r.body).toBe(JSON.stringify({ error: 'studio_foreign_site' }));
      // Rien n'a atteint Next : rien n'a été lancé ni annulé.
      expect(reached).toEqual([]);
    });
  }

  it('even from its own origin, a POST without the token the page received is refused', async () => {
    const { port, reached, own } = await studio();
    const base = { host: `127.0.0.1:${port}`, method: 'POST', body: '{}' };
    for (const headers of [
      { origin: own },
      { origin: own, [STUDIO_CSRF_HEADER]: 'c'.repeat(47) },
      { origin: own, [STUDIO_CSRF_HEADER]: GATE },
    ]) {
      expect((await send(port, { ...base, headers })).body).toBe(
        JSON.stringify({ error: 'studio_no_csrf_token' }),
      );
    }
    expect(reached).toEqual([]);
    const ok = await send(port, {
      ...base,
      headers: { origin: own, 'sec-fetch-site': 'same-origin', [STUDIO_CSRF_HEADER]: CSRF },
    });
    expect(ok.status).toBe(200);
    expect(reached).toEqual([
      { method: 'POST', url: '/bench-studio/api/launch', gate: GATE, csrf: CSRF },
    ]);
  });

  it('the filter never puts the CSRF token on a request: only the page can send it', async () => {
    const { port, reached } = await studio();
    await send(port, { host: `127.0.0.1:${port}`, path: '/bench-studio' });
    expect(reached).toEqual([{ method: 'GET', url: '/bench-studio', gate: GATE, csrf: undefined }]);
  });

  it('a CORS preflight is never granted', async () => {
    const { port, reached, own } = await studio();
    const r = await send(port, {
      host: `127.0.0.1:${port}`,
      method: 'OPTIONS',
      headers: {
        origin: 'http://evil.test',
        'access-control-request-method': 'POST',
        'access-control-request-headers': STUDIO_CSRF_HEADER,
      },
    });
    expect(r.status).toBe(403);
    expect(Object.keys(r.headers).filter((h) => h.startsWith('access-control-'))).toEqual([]);
    const same = await send(port, {
      host: `127.0.0.1:${port}`,
      method: 'OPTIONS',
      headers: { origin: own },
    });
    expect(same.status).toBe(403);
    expect(reached).toEqual([]);
  });

  it('this port serves Bench Studio only: a dashboard route is 404 and never reaches Next', async () => {
    const { port, reached } = await studio();
    for (const path of [
      '/',
      '/agents',
      '/runs/abc',
      '/api/health',
      '/api/auth/session',
      '/bench-studiox',
    ]) {
      const r = await send(port, { host: `127.0.0.1:${port}`, path });
      expect([path, r.status, r.body]).toEqual([
        path,
        404,
        JSON.stringify({ error: 'studio_not_a_studio_route' }),
      ]);
    }
    expect(reached).toEqual([]);
    for (const path of [
      '/bench-studio',
      '/bench-studio/run',
      '/_next/static/chunks/a.js',
      '/logo-128.png',
    ])
      expect((await send(port, { host: `127.0.0.1:${port}`, path })).status).toBe(200);
    expect(reached.map((r) => r.url)).toEqual([
      '/bench-studio',
      '/bench-studio/run',
      '/_next/static/chunks/a.js',
      '/logo-128.png',
    ]);
  });
});

describe('Bench Studio never touches the running stack', () => {
  it('refuses the ports of the stack, read from ~/.nodalai/config.json like release:check', () => {
    const stack = portsDeLaStack({ ports: { web: 3210, runner: 3211 } });
    expect(() => assertStudioPort(3210, stack)).toThrow('bench_studio_port_taken_by_stack: :3210');
    expect(() => assertStudioPort(3211, stack)).toThrow('bench_studio_port_taken_by_stack: :3211');
    const defaults = portsDeLaStack(null);
    expect(() => assertStudioPort(3000, defaults)).toThrow('bench_studio_port_taken_by_stack');
    expect(() => assertStudioPort(3001, defaults)).toThrow('bench_studio_port_taken_by_stack');
    expect(assertStudioPort(STUDIO_PORT, defaults)).toBe(4320);
    expect(() => assertStudioPort(0, defaults)).toThrow('bench_studio_bad_port');
  });

  it('builds into its own folder, never .next, and next.config says the same', async () => {
    expect(STUDIO_DIST_DIR).toBe('.next-studio');
    const config = await import('../../apps/web/next.config.ts');
    expect(config.BENCH_STUDIO_DIST_DIR).toBe(STUDIO_DIST_DIR);
    expect(config.BENCH_STUDIO_ENV).toBe('NODAL_BENCH_STUDIO');
    const env = studioEnv({ PATH: 'p', PORT: '3000' }, 4320, GATE, CSRF);
    expect(env).toMatchObject({
      NODAL_BENCH_STUDIO_CSRF: CSRF,
      NODAL_BENCH_STUDIO: '1',
      NODAL_BENCH_STUDIO_GATE: GATE,
      PORT: '4320',
      PATH: 'p',
    });
  });

  it('outside studio mode the config is the ordinary one: studio files are no route, even on a LAN dev stack', async () => {
    const { default: nextConfigFor, BENCH_STUDIO_ENV } =
      await import('../../apps/web/next.config.ts');
    const saved = process.env[BENCH_STUDIO_ENV];
    try {
      delete process.env[BENCH_STUDIO_ENV];
      for (const phase of [
        'phase-production-build',
        'phase-development-server',
        'phase-production-server',
      ]) {
        const c = nextConfigFor(phase);
        expect(c.pageExtensions).toBeUndefined();
        expect(c.distDir).toBeUndefined();
      }
      process.env[BENCH_STUDIO_ENV] = '1';
      const dev = nextConfigFor('phase-development-server');
      expect(dev.distDir).toBe(STUDIO_DIST_DIR);
      expect(dev.pageExtensions).toEqual(['studio.tsx', 'studio.ts', 'tsx', 'ts', 'jsx', 'js']);
      expect(dev.typescript?.tsconfigPath).toBe('tsconfig.studio.json');
      // Le mode studio n'existe qu'en serveur de dev : un build de production y est refusé.
      expect(() => nextConfigFor('phase-production-build')).toThrow('bench_studio_dev_only');
      expect(() => nextConfigFor('phase-production-server')).toThrow('bench_studio_dev_only');
    } finally {
      if (saved === undefined) delete process.env[BENCH_STUDIO_ENV];
      else process.env[BENCH_STUDIO_ENV] = saved;
    }
  });

  it('puts back next-env.d.ts after Next rewrote it for its build folder', () => {
    const d = mkdtempSync(join(tmpdir(), 'studio-env-'));
    const f = join(d, 'next-env.d.ts');
    writeFileSync(f, 'import "./.next/dev/types/routes.d.ts";\n');
    const restore = keepFile(f);
    writeFileSync(f, 'import "./.next-studio/dev/types/routes.d.ts";\n');
    expect(restore()).toBe(true);
    expect(readFileSync(f, 'utf8')).toBe('import "./.next/dev/types/routes.d.ts";\n');
    expect(restore()).toBe(false);
  });
});

describe('No Bench Studio in a build output', () => {
  function tree(files) {
    const d = mkdtempSync(join(tmpdir(), 'studio-out-'));
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(d, rel, '..'), { recursive: true });
      writeFileSync(join(d, rel), text);
    }
    return d;
  }

  it('a clean output has no trace', () => {
    expect(
      findStudioTraces(
        tree({
          'server/app/(dashboard)/agents/page.js': 'export default 1',
          'server/app-paths-manifest.json':
            '{"/(dashboard)/agents/page":"app/(dashboard)/agents/page.js"}',
        }),
      ),
    ).toEqual([]);
  });

  it('a studio route or chunk is a trace, by its path or by a code only the studio carries', () => {
    const d = tree({
      'server/app/(bench-studio)/bench-studio/page.js': 'x',
      'server/chunks/123.js': 'if(r)return Response.json({error:"studio_not_behind_filter"})',
      'web/node_modules/x/index.js': 'throw new Error(`studio_no_fixture: ${g}`)',
      'cache/webpack/old.pack': 'studio_not_behind_filter',
    });
    expect(findStudioTraces(d).sort()).toEqual([
      'server/app/(bench-studio) (path)',
      'server/chunks/123.js (contains studio_not_behind_filter)',
      'web/node_modules/x/index.js (contains studio_no_fixture)',
    ]);
  });

  it('a studio build folder copied in is a trace', () => {
    expect(findStudioTraces(tree({ 'web/apps/web/.next-studio/x.js': 'x' }))).toEqual([
      'web/apps/web/.next-studio (path)',
    ]);
  });
});
