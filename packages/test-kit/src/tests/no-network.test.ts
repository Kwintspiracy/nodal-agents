// no-network.test.ts — the guard that fails a test file reaching the network.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import net from 'node:net';
import http from 'node:http';
import {
  NetworkForbiddenError,
  installNetworkGuard,
  takeUnscopedNetworkAttempts,
  uninstallNetworkGuard,
  withNetworkScope,
} from '../no-network.ts';

function connectError(host: string, port: number): Promise<Error | null> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.once('error', (err) => resolve(err));
    socket.once('connect', () => {
      socket.destroy();
      resolve(null);
    });
  });
}

describe('the network guard', () => {
  let server: http.Server;
  let port = 0;
  beforeAll(async () => {
    installNetworkGuard();
    server = http.createServer((_req, res) => res.end('local'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as net.AddressInfo).port;
  });
  afterAll(() => {
    server.close();
    uninstallNetworkGuard();
  });

  it('refuses a connection that leaves the machine, before any lookup, and records it', async () => {
    takeUnscopedNetworkAttempts();
    const err = await connectError('provider.example.com', 443);
    expect(err).toBeInstanceOf(NetworkForbiddenError);
    const attempts = takeUnscopedNetworkAttempts();
    expect(attempts.map((a) => a.target)).toEqual(['provider.example.com:443']);
  });

  it('refuses fetch and http to the outside the same way', async () => {
    takeUnscopedNetworkAttempts();
    await expect(fetch('https://provider.example.com/x')).rejects.toThrow();
    await new Promise<void>((resolve) => {
      http.get('http://provider.example.com/x', () => resolve()).once('error', () => resolve());
    });
    expect(takeUnscopedNetworkAttempts().map((a) => a.target)).toEqual([
      'provider.example.com:443',
      'provider.example.com:80',
    ]);
  });

  it('lets this machine through', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(await res.text()).toBe('local');
    expect(takeUnscopedNetworkAttempts()).toEqual([]);
  });

  it('gives a scope its own attempts, and holds them open in hold mode until the client gives up', async () => {
    const { attempts } = await withNetworkScope(
      'held',
      async () => {
        const socket = net.connect({ host: 'provider.example.com', port: 443 });
        await new Promise((r) => setTimeout(r, 50));
        expect(socket.destroyed).toBe(false);
        socket.destroy();
        await new Promise((r) => setTimeout(r, 10));
      },
      'hold',
    );
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.scope).toBe('held');
    expect(attempts[0]!.closedAt).not.toBeNull();
    expect(takeUnscopedNetworkAttempts()).toEqual([]);
  });
});
