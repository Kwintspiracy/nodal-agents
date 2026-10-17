// nodal-home.test.ts — NODALAI_HOME fait une instance ENTIÈRE, du CLI à ses enfants.
//
// Le dossier personnel de l'utilisateur pointe dans un temporaire (USERPROFILE
// sous Windows, HOME ailleurs : ce que `homedir()` lit), pour que « rien n'a été
// créé sous le dossier par défaut » se vérifie sans jamais toucher au vrai
// `~/.nodalai` de la machine qui lance la suite.
//
// config.ts lit le dossier au CHARGEMENT : chaque cas recharge le module après
// avoir posé ses variables (`vi.resetModules`).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let root: string;
let user: string;
let homeB: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nodal-home-cli-'));
  user = join(root, 'user');
  homeB = join(root, 'nodal-b');
  vi.stubEnv('USERPROFILE', user);
  vi.stubEnv('HOME', user);
  vi.stubEnv('NODALAI_HOME', homeB);
  // Les variables étroites d'une suite voisine ne doivent pas masquer le dossier.
  for (const v of ['NODALAI_CONFIG_PATH', 'NODALAI_WORKSPACES_ROOT', 'NODALAI_CHECKPOINTS_ROOT'])
    vi.stubEnv(v, undefined);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const CONFIG = {
  ports: { web: 3100, runner: 3101, postgres: 25532 },
  workerSecret: 'w'.repeat(32),
  bind: 'loopback' as const,
};

describe('the CLI under NODALAI_HOME @cap:installer-et-demarrer/moteur', () => {
  it('derives every path from the home, and writes config, pids, logs, pg-data there only', async () => {
    const cfg = await import('../lib/config.ts');
    expect({
      dir: cfg.CONFIG_DIR,
      file: cfg.CONFIG_FILE,
      pids: cfg.PID_DIR,
      logs: cfg.LOG_DIR,
      pg: cfg.PG_DATA_DIR,
    }).toEqual({
      dir: homeB,
      file: join(homeB, 'config.json'),
      pids: join(homeB, 'pids'),
      logs: join(homeB, 'logs'),
      pg: join(homeB, 'pg-data'),
    });

    cfg.writeConfig(CONFIG);
    for (const d of ['pids', 'logs', 'pg-data'])
      expect(statSync(join(homeB, d)).isDirectory()).toBe(true);
    expect(JSON.parse(readFileSync(join(homeB, 'config.json'), 'utf8')).ports).toEqual(
      CONFIG.ports,
    );
    expect(cfg.readConfig()?.ports).toEqual(CONFIG.ports);
    expect(existsSync(join(user, '.nodalai'))).toBe(false);
  });

  it('puts the launcher and postgres logs under the home', async () => {
    const { LAUNCHER_LOG } = await import('../lib/launcher-log.ts');
    const { PG_LOG_DIR } = await import('../lib/pg-logging.ts');
    expect(LAUNCHER_LOG).toBe(join(homeB, 'logs', 'launcher.log'));
    expect(PG_LOG_DIR).toBe(join(homeB, 'logs', 'postgres'));
  });

  it('hands the resolved home to the runner and the web it starts', async () => {
    const { buildEnvForRunner, buildEnvForWeb } = await import('../lib/env.ts');
    const url = 'postgresql://nodalai:x@localhost:25532/nodalai';
    expect(buildEnvForRunner(CONFIG, url)['NODALAI_HOME']).toBe(homeB);
    expect(buildEnvForWeb(CONFIG, url)['NODALAI_HOME']).toBe(homeB);
  });

  it('hands the default home explicitly when NODALAI_HOME is not set', async () => {
    vi.stubEnv('NODALAI_HOME', undefined);
    const { buildEnvForRunner } = await import('../lib/env.ts');
    expect(buildEnvForRunner(CONFIG, 'postgresql://x@localhost:1/n')['NODALAI_HOME']).toBe(
      join(user, '.nodalai'),
    );
  });

  it('keeps NODALAI_CONFIG_PATH ahead of the home for config.json alone', async () => {
    const elsewhere = join(root, 'elsewhere', 'config.json');
    vi.stubEnv('NODALAI_CONFIG_PATH', elsewhere);
    const cfg = await import('../lib/config.ts');
    expect(cfg.CONFIG_FILE).toBe(elsewhere);
    expect(cfg.PG_DATA_DIR).toBe(join(homeB, 'pg-data'));
    cfg.writeConfig(CONFIG);
    expect(existsSync(elsewhere)).toBe(true);
    expect(existsSync(join(homeB, 'config.json'))).toBe(false);
  });

  it('refuses a home it cannot create, naming it, instead of writing elsewhere', async () => {
    writeFileSync(join(root, 'occupied'), 'x');
    vi.stubEnv('NODALAI_HOME', join(root, 'occupied', 'home'));
    const cfg = await import('../lib/config.ts');
    expect(() => cfg.writeConfig(CONFIG)).toThrow(/home folder .*occupied.* cannot be created/);
    expect(existsSync(join(user, '.nodalai'))).toBe(false);
  });
});

describe('the CLI entry point refuses a bad NODALAI_HOME @cap:installer-et-demarrer/moteur', () => {
  function runCli(env: Record<string, string>): { status: number | null; stderr: string } {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts', '--version'], {
      cwd: CLI_DIR,
      env: { ...process.env, USERPROFILE: user, HOME: user, ...env },
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { status: r.status, stderr: r.stderr };
  }

  it.each([
    ['relative', 'nodal-b', /NODALAI_HOME must be an absolute path, got "nodal-b"/],
    ['empty', '', /NODALAI_HOME is set but empty/],
  ])(
    '%s: exit 1 with the message alone, and nothing created under the default home',
    (_l, value, msg) => {
      const r = runCli({ NODALAI_HOME: value });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(msg);
      expect(r.stderr).not.toMatch(/\n\s+at /);
      expect(existsSync(join(user, '.nodalai'))).toBe(false);
    },
  );

  it('a narrower variable is checked the same way', () => {
    const r = runCli({ NODALAI_HOME: homeB, NODALAI_WORKSPACES_ROOT: 'ws' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/NODALAI_WORKSPACES_ROOT must be an absolute path/);
  });
});
