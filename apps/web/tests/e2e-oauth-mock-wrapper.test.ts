// e2e-oauth-mock-wrapper.test.ts — proves the `pnpm e2e:up` wrapper
// (tests/e2e/up-with-oauth-mock.mjs) actually forwards NODALAI_ALLOW_OAUTH_MOCK=1
// into the `nodal-agents up` child process it spawns (I-9, audit #2 round 2).
//
// Can't spin up a real Nodal-Agents stack here, so this substitutes a fake
// `nodal-agents` executable on PATH that just echoes the env var it received —
// proving the wiring mechanism itself works end-to-end, independent of the
// real CLI.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// apps/web is the vitest root (this file lives at apps/web/tests/), so the
// wrapper script resolves relative to the package root regardless of how
// vitest/vite rewrites `import.meta.url` for transformed test modules.
const WRAPPER_SCRIPT = join(process.cwd(), 'tests', 'e2e', 'up-with-oauth-mock.mjs');

let shimDir: string;

beforeAll(() => {
  shimDir = mkdtempSync(join(tmpdir(), 'nodal-agents-shim-'));

  // The shim's actual logic (shared by both the POSIX and Windows entry
  // points below): print the env var the real `nodal-agents up` would need
  // for the OAuth mock bypass, then exit cleanly.
  const shimLogicPath = join(shimDir, 'shim-logic.mjs');
  writeFileSync(
    shimLogicPath,
    "console.log('NODALAI_ALLOW_OAUTH_MOCK=' + (process.env.NODALAI_ALLOW_OAUTH_MOCK ?? '<unset>'));\n",
    'utf-8',
  );

  // POSIX entry point — a plain shebang script named exactly `nodal-agents`
  // (no extension), executable bit set, resolved by /bin/sh via PATH.
  const posixShimPath = join(shimDir, 'nodal-agents');
  writeFileSync(posixShimPath, `#!/usr/bin/env node\nimport('${toFileUrl(shimLogicPath)}');\n`, {
    encoding: 'utf-8',
  });
  chmodSync(posixShimPath, 0o755);

  // Windows entry point — cmd.exe resolves `nodal-agents` via PATHEXT, which
  // includes .CMD by default.
  const winShimPath = join(shimDir, 'nodal-agents.cmd');
  writeFileSync(winShimPath, `@echo off\r\nnode "${shimLogicPath}"\r\n`, 'utf-8');
});

afterAll(() => {
  rmSync(shimDir, { recursive: true, force: true });
});

function toFileUrl(p: string): string {
  return new URL(`file://${p.replace(/\\/g, '/')}`).toString();
}

describe('pnpm e2e:up wrapper (I-9, audit #2 round 2)', () => {
  it('forwards NODALAI_ALLOW_OAUTH_MOCK=1 to the `nodal-agents up` child process it spawns', async () => {
    const pathSep = process.platform === 'win32' ? ';' : ':';
    // Windows' env var is conventionally `Path` (case varies); set both keys
    // so the PATH override takes effect regardless of platform casing.
    const existingPath = process.env['PATH'] ?? process.env['Path'] ?? '';
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      // Prepend the shim dir so `nodal-agents` resolves to our fake binary
      // instead of any real install.
      PATH: `${shimDir}${pathSep}${existingPath}`,
      Path: `${shimDir}${pathSep}${existingPath}`,
    };
    // Make sure the flag is NOT already set from the outer test process —
    // otherwise the assertion below would be meaningless.
    delete childEnv['NODALAI_ALLOW_OAUTH_MOCK'];

    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [WRAPPER_SCRIPT], {
        env: childEnv,
        shell: false,
      });
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        out += chunk.toString();
      });
      child.on('error', reject);
      child.on('exit', () => resolve(out));
    });

    expect(stdout).toContain('NODALAI_ALLOW_OAUTH_MOCK=1');
    expect(stdout).not.toContain('<unset>');
  });
});
