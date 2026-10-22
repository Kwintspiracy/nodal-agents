// stdio-limits.test.ts — what the MCP SDK's 1.32 security release changed for
// the connections Nodal opens, proven on REAL processes and REAL sockets.
//
//   - GHSA-6prh-2h8m-c8cw (open redirect): an HTTP MCP server that answers a
//     request with a redirect to ANOTHER origin must not be followed: the
//     connector's credentials never reach the target. The connection fails
//     loud, naming the redirect.
//   - The stdio read buffer is bounded. The SDK's default (10 MiB) is below
//     what a tool result legitimately weighs for Nodal (pages rendered as
//     images), so `ScopedStdioTransport` sets its own ceiling
//     (`MCP_STDIO_MAX_MESSAGE_BYTES`), and, like the SDK's own transport, an
//     oversized message closes the connection with an error instead of
//     throwing out of the stream handler.
//
// Mutations verified (reverted afterwards):
//   - `redirectPolicy: 'follow'` on the transport in client.ts → the redirect
//     is followed, the foreign origin receives the request and the key: both
//     redirect tests red.
//   - the try/catch around `readBuffer.append` removed from scoped-stdio.ts →
//     the exception escapes the stream handler, the run reports an uncaught
//     exception and the call never settles: the flood test red.
//   - `{ maxBufferSize }` removed from the `ReadBuffer` (SDK default 10 MiB) →
//     the 12 MiB result closes the connection: the big-result test red, and
//     runner `mcp-tool-result-to-model` (14 MiB of page images) red.

import { describe, it, expect, afterAll } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectMcp } from '../index.ts';
import { MCP_STDIO_MAX_MESSAGE_BYTES } from '../scoped-stdio.ts';

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

describe('the stdio read buffer has the ceiling Nodal accepts, not the SDK default (SDK 1.32) @cap:connecter-un-service/moteur', () => {
  const server = fileURLToPath(new URL('./fixtures/mcp-flood-server.mjs', import.meta.url));
  // Over the SDK's own 10 MiB default, under Nodal's ceiling: a rendered-pages result.
  const BIG_BYTES = 12 * 1024 * 1024;
  const FLOOD_BYTES = MCP_STDIO_MAX_MESSAGE_BYTES + 1024 * 1024;

  const open = (pidFile: string) =>
    connectMcp({
      transport: 'stdio',
      command: process.execPath,
      args: [server, pidFile, String(BIG_BYTES), String(FLOOD_BYTES)],
      env: {},
    });

  it('a single result above the SDK default (12 MiB) reaches the caller whole', async () => {
    const conn = await open(join(dir, 'big.pid'));
    try {
      const result = await conn.client.callTool({ name: 'big', arguments: {} }, undefined, {
        timeout: 30_000,
      });
      const [block] = result.content as Array<{ type: string; text: string }>;
      expect(block?.type).toBe('text');
      expect(block?.text.length).toBe(BIG_BYTES);
    } finally {
      await conn.close();
    }
  }, 60_000);

  it('a server that floods past the ceiling: the call fails, the server process is gone, no exception escapes the stream handler', async () => {
    const pidFile = join(dir, 'flood.pid');
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on('uncaughtException', onUncaught);
    try {
      const conn = await open(pidFile);
      expect(conn.tools.map((t) => t.name)).toEqual(['big', 'flood']);
      const pid = Number(readFileSync(pidFile, 'utf8'));
      expect(isProcessAlive(pid)).toBe(true);
      await expect(
        conn.client.callTool({ name: 'flood', arguments: {} }, undefined, { timeout: 30_000 }),
      ).rejects.toThrow(/Connection closed|exceeded maximum size/);
      for (let i = 0; i < 160 && isProcessAlive(pid); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(isProcessAlive(pid)).toBe(false);
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  }, 90_000);
});
