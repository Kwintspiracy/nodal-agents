// transport.test.ts — what the provider transport decides, and what it leaves
// to others (#608)
//
// Two things the dedicated agent must NOT take over from the platform:
//  - time: the turn clocks (turn-clocks.ts) are the one authority on how long
//    a call may stay silent, up to 600 s before the first token. undici's own
//    header and body timeouts (300 s by default) would cut a model thinking in
//    silence first, with an error no failover or resume recognises;
//  - the network path: a user behind a corporate proxy declares it with
//    HTTP_PROXY / HTTPS_PROXY / NO_PROXY, and provider calls must take it.
//
// `createProviderFetch(undiciDefaults)` stands the undici defaults in with
// short values, so a test can wait past them without waiting 300 s. undici
// runs these on coarse timers (about a second), hence silences of 2 s.

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, afterEach } from 'vitest';

import { createProviderFetch } from '../transport';
import { selfSignedLocalhostCert } from './_tls-fixture';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
});

async function listen(server: http.Server): Promise<number> {
  const sockets = new Set<net.Socket>();
  server.on('connection', (s) => sockets.add(s));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return (server.address() as AddressInfo).port;
}

/** A provider that thinks: `headersAfterMs` of silence, then two body parts `gapMs` apart. */
async function slowProvider(headersAfterMs: number, gapMs: number): Promise<string> {
  const server = http.createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('first ');
      setTimeout(() => res.end('second'), gapMs);
    }, headersAfterMs);
  });
  return `http://127.0.0.1:${await listen(server)}/v1/chat/completions`;
}

/** A plain HTTP proxy that tunnels CONNECT and records every target it was asked for. */
async function recordingProxy(): Promise<{ url: string; targets: string[] }> {
  const targets: string[] = [];
  const proxy = http.createServer((_req, res) => {
    res.writeHead(405);
    res.end();
  });
  proxy.on('connect', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    targets.push(req.url ?? '');
    const [host, port] = (req.url ?? '').split(':');
    const upstream = net.connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  return { url: `http://127.0.0.1:${await listen(proxy)}`, targets };
}

const answer = (_req: http.IncomingMessage, res: http.ServerResponse): void => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('answered');
};

async function answeringProvider(): Promise<number> {
  return listen(http.createServer(answer));
}

async function answeringTlsProvider(): Promise<number> {
  return listen(https.createServer(selfSignedLocalhostCert(), answer) as unknown as http.Server);
}

describe('provider transport (#608) @cap:parler-a-un-agent/moteur', () => {
  it('never cuts a provider that is silent before its headers: the turn clocks decide', async () => {
    const url = await slowProvider(2_000, 0);
    const send = createProviderFetch({ headersTimeout: 150, bodyTimeout: 150 });

    const text = await send(url, { method: 'POST', body: '{}' })
      .then((r) => r.text())
      .catch((e: unknown) => `failed: ${String((e as { cause?: unknown }).cause ?? e)}`);

    expect(text).toBe('first second');
  });

  it('never cuts a provider that is silent between two parts of its body', async () => {
    const url = await slowProvider(0, 2_000);
    const send = createProviderFetch({ headersTimeout: 150, bodyTimeout: 150 });

    const text = await send(url, { method: 'POST', body: '{}' })
      .then((r) => r.text())
      .catch((e: unknown) => `failed: ${String((e as { cause?: unknown }).cause ?? e)}`);

    expect(text).toBe('first second');
  });

  describe('the proxy the environment declares', () => {
    const saved = { ...process.env };
    afterEach(() => {
      for (const k of [
        'HTTP_PROXY',
        'HTTPS_PROXY',
        'NO_PROXY',
        'http_proxy',
        'https_proxy',
        'no_proxy',
        'NODE_TLS_REJECT_UNAUTHORIZED',
      ]) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });

    it('takes HTTP_PROXY', async () => {
      const proxy = await recordingProxy();
      const port = await answeringProvider();
      for (const k of ['NO_PROXY', 'no_proxy', 'http_proxy']) delete process.env[k];
      process.env['HTTP_PROXY'] = proxy.url;
      const send = createProviderFetch();

      const text = await (await send(`http://localhost:${port}/v1/models`)).text();

      expect(text).toBe('answered');
      expect(proxy.targets).toEqual([`localhost:${port}`]);
    });

    it('takes HTTPS_PROXY for a provider over TLS', async () => {
      const proxy = await recordingProxy();
      const port = await answeringTlsProvider();
      for (const k of ['NO_PROXY', 'no_proxy', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
        delete process.env[k];
      }
      process.env['HTTPS_PROXY'] = proxy.url;
      // The stand-in's certificate is self-signed.
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
      const send = createProviderFetch();

      const text = await (await send(`https://localhost:${port}/v1/models`)).text();

      expect(text).toBe('answered');
      expect(proxy.targets).toEqual([`localhost:${port}`]);
    });

    it('goes direct to a host NO_PROXY names', async () => {
      const proxy = await recordingProxy();
      const port = await answeringProvider();
      for (const k of ['http_proxy', 'no_proxy']) delete process.env[k];
      process.env['HTTP_PROXY'] = proxy.url;
      process.env['NO_PROXY'] = 'localhost';
      const send = createProviderFetch();

      const text = await (await send(`http://localhost:${port}/v1/models`)).text();

      expect(text).toBe('answered');
      expect(proxy.targets).toEqual([]);
    });
  });
});
