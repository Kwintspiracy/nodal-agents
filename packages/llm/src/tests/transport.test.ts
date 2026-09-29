// transport.test.ts — what the provider transport decides, and what it leaves
// to others (#608)
//
// Time: a call that carries its own deadline (a signal: the turn clocks, the
// stale retry's timeout, a Stop) is governed by it alone, up to 600 s of
// silence before a first token. undici's own 300 s header and body timeouts
// never apply. A call that carries NO deadline (a key test, an embedding, a
// speech or image request) gets the transport's default one, bounded, so it
// can never hang for ever.
//
// Network path: a user behind a corporate proxy declares it with HTTP_PROXY /
// HTTPS_PROXY / NO_PROXY, and hosted providers are reached through it. A model
// on the user's machine or network (loopback, private ranges, `.local`) is
// reached directly, whatever NO_PROXY says: a proxy cannot reach it.
//
// `createProviderFetch` takes short stand-ins for undici's defaults and for
// the default deadline, so a test can wait past them. undici runs its own
// timers at about one-second granularity, hence silences of 2 s.

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
    // Every target is served locally: the name only has to reach the proxy.
    const port = (req.url ?? '').split(':').at(-1);
    const upstream = net.connect(Number(port), '127.0.0.1', () => {
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
    const send = createProviderFetch({
      undiciDefaults: { headersTimeout: 150, bodyTimeout: 150 },
    });

    // A deadline of its own (never reached): the turn clocks' case.
    const text = await send(url, {
      method: 'POST',
      body: '{}',
      signal: new AbortController().signal,
    })
      .then((r) => r.text())
      .catch((e: unknown) => `failed: ${String((e as { cause?: unknown }).cause ?? e)}`);

    expect(text).toBe('first second');
  });

  it('never cuts a provider that is silent between two parts of its body', async () => {
    const url = await slowProvider(0, 2_000);
    const send = createProviderFetch({
      undiciDefaults: { headersTimeout: 150, bodyTimeout: 150 },
    });

    // A deadline of its own (never reached): the turn clocks' case.
    const text = await send(url, {
      method: 'POST',
      body: '{}',
      signal: new AbortController().signal,
    })
      .then((r) => r.text())
      .catch((e: unknown) => `failed: ${String((e as { cause?: unknown }).cause ?? e)}`);

    expect(text).toBe('first second');
  });

  it('a call with no deadline of its own ends at the default one, and says so', async () => {
    const url = await slowProvider(60_000, 0);
    const send = createProviderFetch({ callTimeoutMs: 300 });
    const started = Date.now();

    const err = await send(url, { method: 'POST', body: '{}' }).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(Date.now() - started).toBeLessThan(3_000);
    expect(err?.name).toBe('TimeoutError');
    expect(err?.message).toBe(
      `provider call to ${new URL(url).origin} got no answer within 300 ms (no deadline was given by the caller)`,
    );
  });

  it('a call that carries its own deadline is never cut by the default one', async () => {
    const url = await slowProvider(1_000, 0);
    const send = createProviderFetch({ callTimeoutMs: 300 });

    const text = await send(url, {
      method: 'POST',
      body: '{}',
      signal: AbortSignal.timeout(10_000),
    })
      .then((r) => r.text())
      .catch((e: unknown) => `failed: ${String(e)}`);

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

    it('takes HTTP_PROXY for a hosted provider', async () => {
      const proxy = await recordingProxy();
      const port = await answeringProvider();
      for (const k of ['NO_PROXY', 'no_proxy', 'http_proxy']) delete process.env[k];
      process.env['HTTP_PROXY'] = proxy.url;
      const send = createProviderFetch();

      const text = await (await send(`http://provider.example.com:${port}/v1/models`)).text();

      expect(text).toBe('answered');
      expect(proxy.targets).toEqual([`provider.example.com:${port}`]);
    });

    it('reaches a model on this machine directly, whatever NO_PROXY says', async () => {
      const proxy = await recordingProxy();
      const port = await answeringProvider();
      for (const k of ['no_proxy', 'http_proxy', 'https_proxy']) delete process.env[k];
      process.env['HTTP_PROXY'] = proxy.url;
      process.env['HTTPS_PROXY'] = proxy.url;
      process.env['NO_PROXY'] = '*.corp.com';
      const send = createProviderFetch();

      const text = await (await send(`http://127.0.0.1:${port}/api/tags`)).text();

      expect(text).toBe('answered');
      expect(proxy.targets).toEqual([]);
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

      const text = await (await send(`https://provider.example.com:${port}/v1/models`)).text();

      expect(text).toBe('answered');
      expect(proxy.targets).toEqual([`provider.example.com:${port}`]);
    });

    it('goes direct to a hosted provider NO_PROXY names', async () => {
      const proxy = await recordingProxy();
      for (const k of ['http_proxy', 'no_proxy']) delete process.env[k];
      process.env['HTTP_PROXY'] = proxy.url;
      process.env['NO_PROXY'] = 'provider.invalid';
      const send = createProviderFetch();

      // Direct means a name lookup of its own, which `.invalid` never passes.
      const err = await send('http://provider.invalid/v1/models').then(
        () => null,
        (e: unknown) => e as Error & { cause?: { code?: string } },
      );

      expect(err?.cause?.code).toBe('ENOTFOUND');
      expect(proxy.targets).toEqual([]);
    });
  });
});
