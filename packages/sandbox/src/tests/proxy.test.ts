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
    // 203.0.113.1 (TEST-NET-3) is not local, so the proxy FORWARDS it instead
    // of refusing (403). It is unroutable, so forwarding hangs or errors — both
    // mean "not refused". We only care that the decision is not a 403: race the
    // request against a short timer (a hang to a blackhole never resolves).
    const r = await Promise.race([
      getThroughProxy(proxy, `http://203.0.113.1:${nodal.port}/`).catch(() => ({
        status: 502,
        body: '',
      })),
      new Promise<{ status: number; body: string }>((resolve) =>
        setTimeout(() => resolve({ status: 0, body: 'forwarding (no fast answer)' }), 2000),
      ),
    ]);
    expect(r.status, JSON.stringify(r)).not.toBe(403);
  });

  it('CONNECT to a denied local port is refused, by the RESOLVED address', async () => {
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

  // Les contournements de la passe 3 : la décision est prise sur l'ADRESSE
  // résolue, pas sur la chaîne de l'hôte.
  it('refuses the denied port reached through a loopback alias (127.0.0.2) and a mapped IPv6', async () => {
    const nodal = await localServer();
    const proxy = await startNodalProxy([{ port: nodal.port }]);
    closers.push(() => proxy.close());
    for (const host of ['127.0.0.2', '127.255.255.254', '[::ffff:127.0.0.1]', '[::1]']) {
      const r = await getThroughProxy(proxy, `http://${host}:${nodal.port}/`);
      expect(r.status, `host ${host}`).toBe(403);
    }
  });

  it('refuses the denied port reached through a NAME that resolves to loopback', async () => {
    const nodal = await localServer();
    const proxy = await startNodalProxy([{ port: nodal.port }]);
    closers.push(() => proxy.close());
    // `localhost` resolves to a loopback address without external DNS; the
    // decision must catch it by its resolved address, not its literal string.
    const r = await getThroughProxy(proxy, `http://localhost:${nodal.port}/`);
    expect(r.status).toBe(403);
  });
});
