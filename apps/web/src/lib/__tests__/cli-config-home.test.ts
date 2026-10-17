// cli-config-home.test.ts — le dashboard lit et écrit la configuration de SON
// instance (NODALAI_HOME, que le CLI lui passe), et lit SES journaux.
//
// Une seconde instance dont l'écran Settings réécrirait `~/.nodalai/config.json`
// changerait le réseau ou l'authentification de la première. Le dossier
// personnel pointe dans un temporaire : rien n'est lu ni écrit dans le vrai.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('server-only', () => ({}));

let root: string;
let user: string;
let homeB: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nodal-home-web-'));
  user = join(root, 'user');
  homeB = join(root, 'nodal-b');
  vi.stubEnv('USERPROFILE', user);
  vi.stubEnv('HOME', user);
  vi.stubEnv('NODALAI_HOME', homeB);
  vi.stubEnv('NODALAI_CONFIG_PATH', undefined);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('the dashboard under NODALAI_HOME', () => {
  it('reads and merges the config.json of its own instance, never ~/.nodalai', async () => {
    mkdirSync(homeB, { recursive: true });
    writeFileSync(
      join(homeB, 'config.json'),
      JSON.stringify({ bind: 'loopback', ports: { web: 3100 } }),
    );
    const { NODALAI_CONFIG_PATH, mergeNodalaiConfig, readNodalaiConfig } =
      await import('../cli-config.ts');
    expect(NODALAI_CONFIG_PATH).toBe(join(homeB, 'config.json'));
    expect(readNodalaiConfig()).toEqual({ bind: 'loopback', ports: { web: 3100 } });

    mergeNodalaiConfig({ bind: 'lan' });
    expect(JSON.parse(readFileSync(join(homeB, 'config.json'), 'utf8'))).toEqual({
      bind: 'lan',
      ports: { web: 3100 },
    });
    expect(existsSync(join(user, '.nodalai'))).toBe(false);
  });

  it('reads the service logs of its own instance', async () => {
    const { serviceLogsDir, serviceLogPath } = await import('../service-logs.ts');
    expect(serviceLogsDir()).toBe(join(homeB, 'logs'));
    expect(serviceLogPath('runner', 'current')).toBe(join(homeB, 'logs', 'runner.log'));
  });
});
