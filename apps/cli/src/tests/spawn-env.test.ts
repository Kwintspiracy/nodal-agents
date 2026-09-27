// spawn-env.test.ts — what the runner and the web actually receive as
// environment (#454, Codex review pass 3).
//
// When the installed version could not be read, NODAL_VERSION was left out of
// the env the launcher built — but the children are spawned with the
// launcher's own environment underneath, so a NODAL_VERSION inherited from
// the shell survived and announced a stale version. A removal is now EXPLICIT
// in the env, and the spawn honours it.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { tmp, execaCalls } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  return {
    tmp: fs.mkdtempSync(path.join(os.tmpdir(), 'nodal-spawn-env-')),
    execaCalls: [] as Array<{ env?: Record<string, string>; extendEnv?: boolean }>,
  };
});

vi.mock('execa', () => ({
  execa: (
    _bin: string,
    _args: string[],
    opts: { env?: Record<string, string>; extendEnv?: boolean },
  ) => {
    execaCalls.push(opts);
    return { pid: 4242, unref: () => {}, stdout: null, stderr: null };
  },
}));

vi.mock('../lib/config.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/config.ts')>();
  return { ...actual, LOG_DIR: tmp };
});

const version = vi.hoisted(() => ({ value: null as string | null }));
vi.mock('../lib/version.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/version.ts')>();
  return { ...actual, readInstalledVersion: () => version.value };
});

import { buildEnvForRunner, buildEnvForWeb } from '../lib/env.ts';
import { spawnRunner, spawnWeb } from '../lib/processes.ts';
import type { Config } from '../lib/config.ts';

const CONFIG: Config = {
  llm: { provider: 'ollama', baseURL: 'http://localhost:11434', model: 'llama3.2' },
  ports: { web: 3000, runner: 3001, postgres: 25432 },
  workerSecret: 'a'.repeat(32),
  authSecret: Buffer.alloc(32, 0x7a).toString('base64'),
  bind: 'loopback',
};
const DB = 'postgresql://nodalai:nodalai@localhost:25432/nodalai';
const inherited = process.env['NODAL_VERSION'];

beforeEach(() => {
  execaCalls.length = 0;
  process.env['NODAL_VERSION'] = '0.8.0-stale';
});
afterEach(() => {
  if (inherited === undefined) delete process.env['NODAL_VERSION'];
  else process.env['NODAL_VERSION'] = inherited;
});

describe('the env a spawned service receives (#454)', () => {
  it('read failed + NODAL_VERSION inherited: neither the runner nor the web receives it', () => {
    version.value = null;
    spawnRunner(buildEnvForRunner(CONFIG, DB));
    spawnWeb(buildEnvForWeb(CONFIG, DB));
    expect(execaCalls).toHaveLength(2);
    for (const call of execaCalls) {
      expect(call.extendEnv).toBe(false);
      expect(call.env && 'NODAL_VERSION' in call.env).toBe(false);
      // The rest of the launcher's environment still reaches the child.
      expect(call.env?.['PATH'] ?? call.env?.['Path']).toBeTruthy();
    }
  });

  it('read succeeded: both receive the installed version, not the inherited one', () => {
    version.value = '0.9.4';
    spawnRunner(buildEnvForRunner(CONFIG, DB));
    spawnWeb(buildEnvForWeb(CONFIG, DB));
    for (const call of execaCalls) expect(call.env?.['NODAL_VERSION']).toBe('0.9.4');
  });
});
