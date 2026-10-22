// npm-floor.test.mjs — the comparison behind the pack-smoke npm floor (11.6.0,
// measured 16/10/2026: npm 11.5.2 crashes on install, 11.6.0 installs).
//
// Run from the repo root: pnpm test:scripts

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { compareVersions, npmUnderTest } from '../lib/npm-floor.mjs';

describe('compareVersions', () => {
  it('orders the npm versions measured around the floor', () => {
    const measured = ['12.2.0', '11.5.2', '10.9.9', '11.6.0', '11.19.1', '11.3.0'];
    expect([...measured].sort(compareVersions)).toEqual([
      '10.9.9',
      '11.3.0',
      '11.5.2',
      '11.6.0',
      '11.19.1',
      '12.2.0',
    ]);
  });

  it('compares numerically, not as text (11.19 is above 11.6)', () => {
    expect(compareVersions('11.19.1', '11.6.0')).toBeGreaterThan(0);
    expect(compareVersions('11.5.2', '11.6.0')).toBeLessThan(0);
    expect(compareVersions('11.6.0', '11.6.0')).toBe(0);
  });

  it('fails loud on something that is not a version', () => {
    expect(() => compareVersions('', '11.6.0')).toThrow(/not a version/);
    expect(() => compareVersions('npm ERR!', '11.6.0')).toThrow(/not a version/);
  });
});

describe('npmUnderTest', () => {
  it('names the npm on PATH when no version is asked for', () => {
    expect(npmUnderTest(undefined)).toBe('npm');
    expect(npmUnderTest('')).toBe('npm');
  });

  it('bootstraps the asked npm through npx WITHOUT the audit and fund calls', () => {
    expect(npmUnderTest('latest')).toBe('npx -y --no-audit --no-fund npm@latest');
    expect(npmUnderTest('11.6.0')).toBe('npx -y --no-audit --no-fund npm@11.6.0');
  });
});

// What npx actually receives when each script bootstraps the npm under test: a
// stand-in `npx` first on PATH writes its argv to a file. The audit call of a
// real bootstrap stalls without answering (22/10/2026: pack-smoke (npm latest)
// timed out at 2 minutes on four PRs); a script that forgets the flag is back
// in that hang, and only the argv shows it.
describe('the scripts that bootstrap the npm under test', () => {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

  it('check-npm-floor.mjs asks npx for npm@<spec> with --no-audit --no-fund', () => {
    const dir = mkdtempSync(join(tmpdir(), 'npm-floor-npx-'));
    try {
      const argvFile = join(dir, 'argv.txt');
      // The shell execSync uses finds `npx.cmd` on Windows, `npx` elsewhere.
      if (process.platform === 'win32') {
        writeFileSync(
          join(dir, 'npx.cmd'),
          `@echo off\r\necho %*> "${argvFile}"\r\necho 12.2.1\r\n`,
        );
      } else {
        writeFileSync(join(dir, 'npx'), `#!/bin/sh\necho "$@" > "${argvFile}"\necho 12.2.1\n`, {
          mode: 0o755,
        });
      }
      const out = execFileSync(
        process.execPath,
        [join(repo, 'scripts/check-npm-floor.mjs'), '11.6.0'],
        {
          encoding: 'utf-8',
          env: {
            ...process.env,
            PATH: `${dir}${delimiter}${process.env.PATH}`,
            NODAL_SMOKE_NPM: 'latest',
          },
        },
      );
      expect(out).toContain('npm 12.2.1');
      expect(readFileSync(argvFile, 'utf-8').trim()).toBe(
        '-y --no-audit --no-fund npm@latest --version',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('smoke-pack.mjs takes its npm from the same place, not from a command line of its own', () => {
    const source = readFileSync(join(repo, 'scripts/smoke-pack.mjs'), 'utf-8');
    expect(source).toContain('npmUnderTest(process.env.NODAL_SMOKE_NPM)');
    expect(source).not.toMatch(/npx -y/);
  });
});
