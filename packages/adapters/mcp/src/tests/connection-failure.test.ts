// connection-failure.test.ts — what a failed MCP connection says about its
// server, through the real transports: a command that is not on this machine,
// a server that refuses the key, one that does not answer. Local only.

import { describe, it, expect, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connectMcp } from '../client.ts';
import { mcpConnectionFailure } from '../connection-failure.ts';

const servers: Server[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(() => r(null)))));
});

async function httpServer(status: number): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'nope' }));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

async function failureOf(opts: Parameters<typeof connectMcp>[0]): Promise<unknown> {
  try {
    const conn = await connectMcp(opts);
    await conn.close();
  } catch (err) {
    return err;
  }
  throw new Error('the connection was expected to fail');
}

describe('an MCP connection failure is its server state @cap:connecter-un-service/moteur', () => {
  it('a command that does not exist: broken, command_not_found, with the system words', async () => {
    const err = await failureOf({
      transport: 'stdio',
      command: 'nodal-no-such-mcp-server-command',
      args: [],
      env: {},
    });
    const state = mcpConnectionFailure(err);
    expect(state).toMatchObject({ state: 'broken', cause: 'command_not_found' });
    expect(state.detail).toContain('nodal-no-such-mcp-server-command');
  }, 30_000);

  it('each form a missing command takes, whatever the system: broken', () => {
    // Linux and macOS: spawn fails with ENOENT, its code kept or only in the text.
    expect(mcpConnectionFailure(new Error('spawn nodal-x ENOENT')).state).toBe('broken');
    expect(
      mcpConnectionFailure(Object.assign(new Error('spawn nodal-x'), { code: 'ENOENT' })).state,
    ).toBe('broken');
    // A word that merely contains the letters is not the code.
    expect(mcpConnectionFailure(new Error('XENOENTX happened')).state).toBe('unreachable');
  });

  it('a server that refuses the key (401): needs_reauth', async () => {
    const url = await httpServer(401);
    const err = await failureOf({
      transport: 'http',
      url,
      apiKey: 'wrong',
      authScheme: 'bearer',
      authParamName: 'Authorization',
    });
    expect(mcpConnectionFailure(err)).toMatchObject({
      state: 'needs_reauth',
      cause: 'grant_refused',
    });
  }, 30_000);

  it('a server that answers 503: unreachable, with a retry time', async () => {
    const url = await httpServer(503);
    const err = await failureOf({
      transport: 'http',
      url,
      apiKey: 'k',
      authScheme: 'bearer',
      authParamName: 'Authorization',
    });
    const state = mcpConnectionFailure(err);
    expect(state).toMatchObject({ state: 'unreachable', cause: 'provider_unavailable' });
    expect(state.retryAfter).toBeInstanceOf(Date);
  }, 30_000);

  it('nobody listening: unreachable, network', async () => {
    const url = await httpServer(200);
    const port = new URL(url).port;
    await new Promise((r) => servers.pop()!.close(() => r(null)));
    const err = await failureOf({
      transport: 'http',
      url: `http://127.0.0.1:${port}/mcp`,
      apiKey: 'k',
      authScheme: 'bearer',
      authParamName: 'Authorization',
    });
    expect(mcpConnectionFailure(err)).toMatchObject({ state: 'unreachable', cause: 'network' });
  }, 30_000);
});
