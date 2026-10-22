// stdio-process-tree.test.ts — a stdio MCP server belongs to whoever opened it
// (#750), on REAL processes.
//
// The server is behind an intermediary (fixtures/mcp-launcher.mjs, the shape of
// `npx` and `uvx`), and has a detached helper. What is proven:
//   - closing the connection kills the server ITSELF, not only the
//     intermediary Nodal holds (the SDK's own transport kills its direct child
//     only, and on Windows SIGTERM to the launcher leaves the server running);
//   - opened by a job (`processScope`), the detached helper lives until the
//     JOB ends, then dies with it;
//   - opened outside any job (the connectors page testing a server), the
//     connection's own scope is closed with it: nothing survives the test.
//
// Mutation verified (reverted afterwards): `ScopedStdioTransport` replaced by
// the SDK's `StdioClientTransport` in client.ts → the helper survives the
// close, both tests red.

import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { watchProcess, type ProcessWatch } from '@nodal-agents/test-kit';
import { openProcessScope } from '@nodal-agents/tools';
import { connectMcp } from '../index.ts';

const LAUNCHER = fileURLToPath(new URL('./fixtures/mcp-launcher.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'nodal-mcp-tree-'));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));

// Each pid is HELD as soon as it is read, while its process has just written
// it: from then on it can only name that process, alive or dead, and killing it
// can reach nobody else (#841, packages/test-kit/src/process-watch.ts).
const watches: ProcessWatch[] = [];
afterEach(() => {
  for (const w of watches.splice(0)) w.release();
});

async function pidIn(file: string): Promise<ProcessWatch> {
  for (let i = 0; i < 200 && !existsSync(file); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const watch = await watchProcess(Number(readFileSync(file, 'utf8')));
  watches.push(watch);
  return watch;
}

async function deadWithin(watch: ProcessWatch, ms: number): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 50) {
    if (!watch.alive()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !watch.kill();
}

describe('a stdio MCP server belongs to whoever opened it (#750) @cap:connecter-un-service/moteur', () => {
  it('opened by a job: closing the connection kills the server behind its launcher; its detached helper dies with the job', async () => {
    const scope = openProcessScope(`mcp-tree-job:${randomUUID()}`);
    const serverPid = join(dir, 'job-server.pid');
    const helperPid = join(dir, 'job-helper.pid');
    try {
      const conn = await connectMcp({
        transport: 'stdio',
        command: process.execPath,
        args: [LAUNCHER, serverPid, helperPid],
        env: {},
        processScope: scope,
      });
      expect(conn.tools.map((t) => t.name)).toEqual(['ping']);
      const server = await pidIn(serverPid);
      const helper = await pidIn(helperPid);
      expect(server.alive()).toBe(true);
      await conn.close();
      expect(await deadWithin(server, 8_000)).toBe(true);
      // Le job continue : son aide détachée vit encore.
      expect(helper.alive()).toBe(true);
      await scope.close();
      expect(await deadWithin(helper, 5_000)).toBe(true);
    } finally {
      await scope.close();
    }
  }, 60_000);

  it('opened outside any job: the connection owns its processes and nothing survives its close', async () => {
    const serverPid = join(dir, 'own-server.pid');
    const helperPid = join(dir, 'own-helper.pid');
    const conn = await connectMcp({
      transport: 'stdio',
      command: process.execPath,
      args: [LAUNCHER, serverPid, helperPid],
      env: {},
    });
    const server = await pidIn(serverPid);
    const helper = await pidIn(helperPid);
    await conn.close();
    expect(await deadWithin(server, 8_000)).toBe(true);
    expect(await deadWithin(helper, 5_000)).toBe(true);
  }, 60_000);

  // Like the SDK: where the system starts nothing (Unix), the launch error
  // itself (`spawn … ENOENT`); where `cross-spawn` hands an unresolved command
  // to `cmd.exe` (Windows), cmd starts, says so on stderr and exits, and the
  // connection closes before initialize.
  it('a command that cannot be launched fails the connection, like the SDK', async () => {
    await expect(
      connectMcp({
        transport: 'stdio',
        command: join(dir, 'no-such-server-binary'),
        args: [],
        env: {},
      }),
    ).rejects.toThrow(/ENOENT|Connection closed/);
  }, 30_000);
});
