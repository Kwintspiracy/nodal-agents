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

/** A config as the CLI writes it, plus a key this version does not know. */
const VALID = {
  ports: { web: 3100, runner: 3101, postgres: 25532 },
  workerSecret: 'w'.repeat(64),
  postgresPassword: 'p'.repeat(32),
  bind: 'loopback',
  futureKey: { kept: true },
};

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
    writeFileSync(join(homeB, 'config.json'), JSON.stringify(VALID));
    const { NODALAI_CONFIG_PATH, mergeNodalaiConfig, readNodalaiConfig } =
      await import('../cli-config.ts');
    expect(NODALAI_CONFIG_PATH).toBe(join(homeB, 'config.json'));
    expect(readNodalaiConfig()).toEqual(VALID);

    mergeNodalaiConfig({ bind: 'lan' });
    expect(JSON.parse(readFileSync(join(homeB, 'config.json'), 'utf8'))).toEqual({
      ...VALID,
      bind: 'lan',
    });
    expect(existsSync(join(user, '.nodalai'))).toBe(false);
  });

  it('reads the service logs of its own instance', async () => {
    const { serviceLogsDir, serviceLogPath } = await import('../service-logs.ts');
    expect(serviceLogsDir()).toBe(join(homeB, 'logs'));
    expect(serviceLogPath('runner', 'current')).toBe(join(homeB, 'logs', 'runner.log'));
  });
});

describe('the dashboard and an unusable config.json @cap:installer-et-demarrer/moteur', () => {
  it('a broken file is reported as broken (named, with its reason), never as missing, and never written over', async () => {
    mkdirSync(homeB, { recursive: true });
    const file = join(homeB, 'config.json');
    const broken = '{"bind": "loopback",';
    writeFileSync(file, broken);
    const { mergeNodalaiConfig, readNodalaiConfig } = await import('../cli-config.ts');
    const { StateFileError } = await import('@nodal-agents/shared/state-files');

    expect(() => readNodalaiConfig()).toThrow(StateFileError);
    expect(() => readNodalaiConfig()).toThrow(file);
    expect(() => mergeNodalaiConfig({ bind: 'lan' })).toThrow(/Nothing was changed/);
    expect(readFileSync(file, 'utf8')).toBe(broken);
  });

  it('a change that would make the config invalid is refused before anything is written', async () => {
    mkdirSync(homeB, { recursive: true });
    const file = join(homeB, 'config.json');
    writeFileSync(file, JSON.stringify(VALID));
    const { mergeNodalaiConfig } = await import('../cli-config.ts');
    expect(() =>
      mergeNodalaiConfig({ ports: { web: 3101, runner: 3101, postgres: 25532 } }),
    ).toThrow(/three different ports/);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(VALID);
  });

  it('an absent file is absent: null, and a change is refused as absent', async () => {
    const { mergeNodalaiConfig, readNodalaiConfig } = await import('../cli-config.ts');
    expect(readNodalaiConfig()).toBeNull();
    let code = '';
    try {
      mergeNodalaiConfig({ bind: 'lan' });
    } catch (err) {
      code = (err as { code?: string }).code ?? '';
    }
    expect(code).toBe('STATE_FILE_ABSENT');
    expect(existsSync(join(homeB, 'config.json'))).toBe(false);
  });
});
