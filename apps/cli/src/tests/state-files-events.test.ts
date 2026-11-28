// state-files-events.test.ts — the four ordinary events that used to lock an
// install out of its own database, on a REAL initialised home.
//
// The home is a temporary folder (with a space and non-ASCII characters in its
// name) holding what an install holds: a config created by the CLI, a
// database folder (`pg-data/PG_VERSION`) and a master key. After each event the
// database password read back is the original one, or the command stopped
// with the stated error and the file on disk is byte-identical to before.
//
// The four events: re-running `init` (the docs recommend it), a save cut short
// (every byte position), a config written by another version (an unknown key,
// a missing known key), a hand edit that breaks the JSON. Then the crash at
// the seam of the atomic replace, killed for real in a child process, and the
// real CLI binary on an unusable config.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execa } from 'execa';

vi.mock('../lib/llm-presets.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/llm-presets.ts')>();
  return {
    ...real,
    // No network: the wizard falls back to typing the model name.
    fetchModels: vi.fn(async () => null),
    isEndpointReachable: vi.fn(async () => true),
  };
});

const cliDir = fileURLToPath(new URL('../..', import.meta.url));
const stateFilesModule = pathToFileURL(
  join(cliDir, '..', '..', 'packages', 'shared', 'src', 'nodal-config-file.ts'),
).href;

let root: string;
let user: string;
let home: string;
let configFile: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nodal-events-'));
  user = join(root, 'user');
  home = join(root, 'Données de Zoë', 'nodal home');
  mkdirSync(user, { recursive: true });
  configFile = join(home, 'config.json');
  vi.stubEnv('USERPROFILE', user);
  vi.stubEnv('HOME', user);
  vi.stubEnv('NODALAI_HOME', home);
  vi.stubEnv('NODALAI_CONFIG_PATH', undefined);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

type ConfigModule = typeof import('../lib/config.ts');

async function configModule(): Promise<ConfigModule> {
  return import('../lib/config.ts');
}

/** What an install holds after its first start: config, database folder, master key. */
async function initialisedHome(): Promise<{ password: string; bytes: Buffer }> {
  const cfg = await configModule();
  const config = cfg.newInstallConfig();
  cfg.createConfig(config);
  mkdirSync(join(home, 'pg-data'), { recursive: true });
  writeFileSync(join(home, 'pg-data', 'PG_VERSION'), '18\n');
  writeFileSync(join(home, 'secrets.key'), Buffer.alloc(32, 7).toString('base64'));
  return { password: config.postgresPassword!, bytes: readFileSync(configFile) };
}

function onDisk(): Record<string, unknown> {
  return JSON.parse(readFileSync(configFile, 'utf-8')) as Record<string, unknown>;
}

function caught(fn: () => unknown): Error & { code?: string } {
  try {
    fn();
  } catch (err) {
    return err as Error & { code?: string };
  }
  throw new Error('expected an error, nothing was thrown');
}

describe('event 1: re-running `init` on an installed home @cap:installer-et-demarrer/moteur', () => {
  it('the wizard edits: the LLM and the network change, the password and every secret stay', async () => {
    const { password } = await initialisedHome();
    const before = onDisk();
    writeFileSync(configFile, JSON.stringify({ ...before, futureKey: { kept: true } }, null, 2));

    const prompts = (await import('prompts')).default;
    // proceed, provider (Ollama), endpoint, model typed, network
    prompts.inject([true, 0, 'http://127.0.0.1:11434', 'llama3.2', 'lan']);
    const { runInit } = await import('../commands/init.ts');
    await runInit();

    const after = onDisk();
    expect(after['postgresPassword']).toBe(password);
    for (const key of ['workerSecret', 'authSecret', 'serverActionsKey', 'ports'] as const) {
      expect(after[key], key).toEqual(before[key]);
    }
    expect(after['futureKey']).toEqual({ kept: true });
    expect(after['bind']).toBe('lan');
    expect((after['llm'] as { provider: string }).provider).toBe('ollama');
    // The version before the edit is kept.
    const lastGood = JSON.parse(readFileSync(`${configFile}.last-good`, 'utf-8')) as {
      bind: string;
    };
    expect(lastGood.bind).toBe('loopback');
  });

  it('`init --force --non-interactive` edits too: password kept, LAN and sign-in applied', async () => {
    const { password } = await initialisedHome();
    const { runInit } = await import('../commands/init.ts');
    await runInit({ force: true, nonInteractive: true });
    const after = onDisk();
    expect(after['postgresPassword']).toBe(password);
    expect(after['bind']).toBe('lan');
    expect(after['auth']).toEqual({ mode: 'local-auth' });
  });

  it('`init` over an unusable config stops with the reason and writes nothing', async () => {
    await initialisedHome();
    const broken = Buffer.from('{ "bind": "lan", }');
    writeFileSync(configFile, broken);
    const { runInit } = await import('../commands/init.ts');
    await expect(runInit({ force: true, nonInteractive: true })).rejects.toThrow(
      /Nothing was changed/,
    );
    expect(readFileSync(configFile).equals(broken)).toBe(true);
  });
});

describe('event 2: a save cut short @cap:installer-et-demarrer/moteur', () => {
  it('a config truncated at every byte stops `up`’s reader and `init`, file byte-identical', async () => {
    const { bytes } = await initialisedHome();
    const cfg = await configModule();
    const { runInit } = await import('../commands/init.ts');
    // The last byte is the trailing newline: every shorter prefix is broken.
    for (let cut = 0; cut < bytes.length - 1; cut++) {
      const partial = bytes.subarray(0, cut);
      writeFileSync(configFile, partial);
      const err = caught(() => cfg.readConfig());
      expect(err.code, `cut at ${cut}`).toBe('STATE_FILE_INVALID');
      await expect(runInit({ nonInteractive: true, force: true })).rejects.toThrow();
      expect(readFileSync(configFile).equals(partial), `cut at ${cut}`).toBe(true);
    }
  }, 300_000);

  it('a process killed between the temporary write and the rename leaves the old file whole', async () => {
    const { password, bytes } = await initialisedHome();
    const marker = join(root, 'at-the-seam');
    const script = join(root, 'writer.mts');
    writeFileSync(
      script,
      [
        `import { writeFileSync } from 'node:fs';`,
        `import { writeNodalConfigFile, readNodalConfigFile } from ${JSON.stringify(stateFilesModule)};`,
        `const file = ${JSON.stringify(configFile)};`,
        `const next = { ...readNodalConfigFile(file), postgresPassword: 'n'.repeat(32) };`,
        `writeNodalConfigFile(file, next, { beforeRename: () => {`,
        `  writeFileSync(${JSON.stringify(marker)}, 'x');`,
        `  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);`,
        `} });`,
      ].join('\n'),
    );
    const child = spawn(process.execPath, ['--import', 'tsx', script], {
      cwd: cliDir,
      stdio: 'ignore',
    });
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
    const deadline = Date.now() + 60_000;
    while (!existsSync(marker)) {
      if (Date.now() > deadline) throw new Error('the writer never reached the seam');
      await new Promise((r) => setTimeout(r, 50));
    }
    child.kill('SIGKILL');
    await exited;

    expect(readFileSync(configFile).equals(bytes)).toBe(true);
    expect((await configModule()).readConfig()?.postgresPassword).toBe(password);
  }, 90_000);
});

describe('event 3: a config written by another version @cap:installer-et-demarrer/moteur', () => {
  it('an unknown key survives the write that mints a missing known key; the password stays', async () => {
    const { password } = await initialisedHome();
    const { serverActionsKey: _dropped, ...rest } = onDisk();
    writeFileSync(configFile, JSON.stringify({ ...rest, voice: { engine: 'local' } }, null, 2));

    const config = (await configModule()).readConfig();

    expect(config?.postgresPassword).toBe(password);
    const after = onDisk();
    expect(typeof after['serverActionsKey']).toBe('string');
    expect(after['voice']).toEqual({ engine: 'local' });
    expect(after['postgresPassword']).toBe(password);
  });

  it('a missing REQUIRED key is refused, the file left byte-identical', async () => {
    await initialisedHome();
    const { workerSecret: _gone, ...rest } = onDisk();
    const text = JSON.stringify(rest);
    writeFileSync(configFile, text);
    const cfg = await configModule();
    const refused = caught(() => cfg.readConfig());
    expect(refused.code).toBe('STATE_FILE_INVALID');
    expect(refused.message).toContain('workerSecret');
    expect(readFileSync(configFile, 'utf-8')).toBe(text);
  });
});

describe('event 4: a hand edit that breaks the JSON @cap:installer-et-demarrer/moteur', () => {
  it('is refused with the file and the last good copy named; restoring the copy brings the password back', async () => {
    const { password } = await initialisedHome();
    const cfg = await configModule();
    cfg.writeConfig({ ...cfg.readConfig()!, bind: 'lan', auth: { mode: 'local-auth' } });
    const broken = readFileSync(configFile, 'utf-8').replace('"bind": "lan"', '"bind": "lan",,');
    writeFileSync(configFile, broken);

    const err = caught(() => cfg.readConfig());
    expect(err.message).toContain(configFile);
    expect(err.message).toContain('Nothing was changed');
    expect(err.message).toContain(`${configFile}.last-good`);
    expect(readFileSync(configFile, 'utf-8')).toBe(broken);

    copyFileSync(`${configFile}.last-good`, configFile);
    expect(cfg.readConfig()?.postgresPassword).toBe(password);
  });
});

describe('a missing config in a home that holds an install @cap:installer-et-demarrer/moteur', () => {
  it('is not a first run: nothing is written, and the message says what to put back', async () => {
    await initialisedHome();
    const cfg = await configModule();
    cfg.writeConfig({ ...cfg.readConfig()!, bind: 'lan', auth: { mode: 'local-auth' } });
    rmSync(configFile);

    const err = caught(() => cfg.createConfig(cfg.newInstallConfig()));
    expect(err.message).toContain(join(home, 'pg-data'));
    expect(err.message).toContain(join(home, 'secrets.key'));
    expect(err.message).toContain(`Copy ${configFile}.last-good to ${configFile}`);
    expect(existsSync(configFile)).toBe(false);
  });

  it('a truly new home is a first run: a config is created, its database password minted', async () => {
    const cfg = await configModule();
    cfg.createConfig(cfg.newInstallConfig());
    const config = cfg.readConfig();
    expect(config?.postgresPassword?.length).toBeGreaterThanOrEqual(16);
    expect(config?.postgresPasswordPending).toBeUndefined();
  });
});

describe('the record of started processes @cap:installer-et-demarrer/moteur', () => {
  it('an unreadable record is an error that says what to do, never "nothing runs"', async () => {
    await initialisedHome();
    mkdirSync(join(home, 'pids'), { recursive: true });
    const file = join(home, 'pids', 'processes.json');
    writeFileSync(file, '{"runner": 12');
    const { readPids, clearPids } = await import('../lib/processes.ts');
    const err = caught(() => readPids());
    expect(err.code).toBe('STATE_FILE_INVALID');
    expect(err.message).toContain('delete this file');
    expect(() => clearPids()).toThrow();
    expect(readFileSync(file, 'utf-8')).toBe('{"runner": 12');
  });
});

describe('the real CLI on an unusable config @cap:installer-et-demarrer/moteur', () => {
  async function cli(args: string[]): Promise<{ code: number | undefined; output: string }> {
    const run = await execa(
      process.execPath,
      ['--import', 'tsx', join(cliDir, 'src', 'index.ts'), ...args],
      {
        cwd: cliDir,
        env: {
          NODALAI_HOME: home,
          USERPROFILE: user,
          HOME: user,
          NODALAI_NO_BROWSER: '1',
        },
        extendEnv: true,
        reject: false,
        timeout: 280_000,
      },
    );
    return { code: run.exitCode, output: `${run.stdout}\n${run.stderr}` };
  }

  it('`up` stops before starting anything, names the file, and leaves it byte-identical', async () => {
    await initialisedHome();
    const broken = Buffer.from(readFileSync(configFile, 'utf-8').slice(0, 40));
    writeFileSync(configFile, broken);

    const run = await cli(['up']);

    expect(run.code).not.toBe(0);
    expect(run.output).toContain(configFile);
    expect(run.output).toContain('Nothing was changed');
    expect(run.output).not.toContain('First run');
    expect(readFileSync(configFile).equals(broken)).toBe(true);
    expect(existsSync(join(home, 'pids', 'processes.json'))).toBe(false);
  }, 300_000);

  it('`init --force --non-interactive` keeps the database password', async () => {
    const { password } = await initialisedHome();
    const run = await cli(['init', '--force', '--non-interactive']);
    expect(run.code).toBe(0);
    expect(onDisk()['postgresPassword']).toBe(password);
  }, 300_000);
});
