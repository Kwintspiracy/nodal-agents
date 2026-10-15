// proxy.test.ts — le proxy filtrant côté hôte (#628, D2), sur tous les
// systèmes. Il laisse passer une destination quelconque et REFUSE les ports de
// Nodal sur les adresses locales, pour HTTP, CONNECT et l'upgrade websocket.
// Le vrai filtrage dans un conteneur MXC est prouvé par
// sandbox-proxy-windows.test.ts (Windows, 9711).

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { startNodalProxy, localAddresses, type NodalProxy } from '../proxy';

const closers: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

/** Un petit serveur HTTP local qui répond son propre port. */
async function localServer(): Promise<{ port: number; server: Server }> {
  const server = createServer((_q, r) => r.end('ok'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  closers.push(() => new Promise<void>((r) => server.close(() => r())));
  return { port: (server.address() as { port: number }).port, server };
}

/** GET through the proxy (absolute-form), returns status + body or an error. */
function getThroughProxy(
  proxy: NodalProxy,
  targetUrl: string,
): Promise<{ status: number; body: string }> {
  const proxyPort = Number(new URL(proxy.url).port);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: proxyPort, method: 'GET', path: targetUrl },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('startNodalProxy @cap:executer-une-commande/moteur', () => {
  it('forwards to a non-Nodal local port, refuses a denied Nodal port (HTTP)', async () => {
    const allowed = await localServer();
    const nodal = await localServer();
    const proxy = await startNodalProxy([{ port: nodal.port }]);
    closers.push(() => proxy.close());

    const ok = await getThroughProxy(proxy, `http://127.0.0.1:${allowed.port}/`);
    expect(ok).toEqual({ status: 200, body: 'ok' });

    const refused = await getThroughProxy(proxy, `http://127.0.0.1:${nodal.port}/`);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatch(/nodal endpoint refused/);
    expect(proxy.refusedCount()).toBe(1);
  });

  it('refuses the denied port on ::1 and on a LAN address too, not only 127.0.0.1', async () => {
    const nodal = await localServer();
    const proxy = await startNodalProxy([{ port: nodal.port }]);
    closers.push(() => proxy.close());
    for (const host of [
      '::1',
      ...[...localAddresses()].filter(
        (a) => /^\d+\.\d+\.\d+\.\d+$/.test(a) && a !== '127.0.0.1' && a !== '0.0.0.0',
      ),
    ]) {
      const r = await getThroughProxy(
        proxy,
        `http://${host.includes(':') ? `[${host}]` : host}:${nodal.port}/`,
      );
      expect(r.status, `host ${host}`).toBe(403);
    }
  });

  it('a remote host on the same port number is NOT refused (only local endpoints)', async () => {
    const nodal = await localServer();
    const proxy = await startNodalProxy([{ port: nodal.port }]);
    closers.push(() => proxy.close());
    // 203.0.113.1 (TEST-NET-3) is not local; the proxy must try to forward it
    // (it will fail to connect, 502 — but NOT a 403 refusal).
    const r = await getThroughProxy(proxy, `http://203.0.113.1:${nodal.port}/`).catch(() => ({
      status: 502,
      body: '',
    }));
    expect(r.status).not.toBe(403);
  });

  it('CONNECT to a denied local port is refused', async () => {
    const nodal = await localServer();
    const proxy = await startNodalProxy([{ port: nodal.port }]);
    closers.push(() => proxy.close());
    const proxyPort = Number(new URL(proxy.url).port);
    const sock = connect(proxyPort, '127.0.0.1');
    await once(sock, 'connect');
    sock.write(`CONNECT 127.0.0.1:${nodal.port} HTTP/1.1\r\nHost: 127.0.0.1:${nodal.port}\r\n\r\n`);
    const [chunk] = (await once(sock, 'data')) as [Buffer];
    expect(String(chunk)).toMatch(/^HTTP\/1\.1 403/);
    sock.destroy();
  });
});
