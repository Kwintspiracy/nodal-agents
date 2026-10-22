// stdio-limits.test.ts — what the MCP SDK's 1.32 security release changed for
// the connections Nodal opens, proven on REAL processes and REAL sockets.
//
//   - GHSA-6prh-2h8m-c8cw (open redirect): an HTTP MCP server that answers a
//     request with a redirect to ANOTHER origin must not be followed: the
//     connector's credentials never reach the target. The connection fails
//     loud, naming the redirect.
//   - The stdio read buffer is bounded (10 MB). `ScopedStdioTransport` mirrors
//     the SDK's own transport: an oversized message closes the connection with
//     an error instead of throwing out of the stream handler.
//
// Mutations verified (reverted afterwards):
//   - `redirectPolicy: 'follow'` on the transport in client.ts → the redirect
//     is followed, the foreign origin receives the request and the key: both
//     redirect tests red.
//   - the try/catch around `readBuffer.append` removed from scoped-stdio.ts →
//     the exception escapes the stream handler, the run reports an uncaught
//     exception and the call never settles: the flood test red.

import { describe, it, expect, afterAll } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectMcp } from '../index.ts';

const dir = mkdtempSync(join(tmpdir(), 'nodal-mcp-limits-'));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

interface Seen {
  method: string | undefined;
  headers: IncomingHttpHeaders;
}

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  );
const shut = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

describe('an HTTP MCP server cannot send the connector elsewhere (SDK 1.32, GHSA-6prh-2h8m-c8cw) @cap:connecter-un-service/moteur', () => {
  // 301/302/303 turn a POST into a GET, 307/308 keep method and body: the
  // latter are the ones that would carry the JSON-RPC body AND the key.
  it.each([301, 302, 303, 307, 308])(
    'a %i to another origin is not followed: the foreign origin sees nothing, the connection fails naming the redirect',
    async (status) => {
      const foreignSeen: Seen[] = [];
      const foreign = createServer((req, res) => {
        foreignSeen.push({ method: req.method, headers: req.headers });
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      });
      const foreignPort = await listen(foreign);
      const origin = createServer((_req, res) => {
        res.writeHead(status, { location: `http://127.0.0.1:${foreignPort}/mcp` }).end();
      });
      const originPort = await listen(origin);
      try {
        const attempt = connectMcp({
          transport: 'http',
          url: `http://127.0.0.1:${originPort}/mcp`,
          apiKey: 'sk-connector-secret',
          authScheme: 'bearer',
        });
        await expect(attempt).rejects.toThrow(/redirect/i);
        expect(foreignSeen).toEqual([]);
      } finally {
        await shut(origin);
        await shut(foreign);
      }
    },
    30_000,
  );
});

describe('a stdio MCP server that floods past the read-buffer ceiling closes its connection, it does not crash the runner (SDK 1.32) @cap:connecter-un-service/moteur', () => {
  it('the call fails, the server process is gone, and no exception escapes the stream handler', async () => {
    const pidFile = join(dir, 'flood.pid');
    const server = fileURLToPath(new URL('./fixtures/mcp-flood-server.mjs', import.meta.url));
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on('uncaughtException', onUncaught);
    try {
      const conn = await connectMcp({
        transport: 'stdio',
        command: process.execPath,
        args: [server, pidFile],
        env: {},
      });
      expect(conn.tools.map((t) => t.name)).toEqual(['flood']);
      const pid = Number(readFileSync(pidFile, 'utf8'));
      expect(isProcessAlive(pid)).toBe(true);
      await expect(
        conn.client.callTool({ name: 'flood', arguments: {} }, undefined, { timeout: 20_000 }),
      ).rejects.toThrow(/Connection closed|exceeded maximum size/);
      for (let i = 0; i < 160 && isProcessAlive(pid); i++)
        await new Promise((r) => setTimeout(r, 50));
      expect(isProcessAlive(pid)).toBe(false);
      expect(uncaught).toEqual([]);
      expect(existsSync(pidFile)).toBe(true);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  }, 60_000);
});
