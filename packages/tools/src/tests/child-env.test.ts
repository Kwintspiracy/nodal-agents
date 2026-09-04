// child-env.test.ts — buildChildEnv() strips runner secrets before a spawned
// process (run_command / run_skill_script) ever sees them, while keeping the
// OS/shell plumbing a command needs to actually run (PATH first of all).

import { describe, it, expect } from 'vitest';
import { ENV_ALLOWLIST_VERSION, sha256Hex } from '@nodal-agents/shared';
import { buildChildEnv, safeEnvAllowlistSnapshot } from '../builtin/child-env';

describe('buildChildEnv', () => {
  it('keeps PATH but drops DATABASE_URL/WORKER_SECRET/OPENAI_API_KEY', () => {
    const source: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin',
      DATABASE_URL: 'postgres://user:pass@host/db',
      WORKER_SECRET: 'super-secret-worker-token',
      OPENAI_API_KEY: 'sk-fake-key',
    };

    const result = buildChildEnv(source);

    expect(result['PATH']).toBe('/usr/bin:/bin');
    expect(result['DATABASE_URL']).toBeUndefined();
    expect(result['WORKER_SECRET']).toBeUndefined();
    expect(result['OPENAI_API_KEY']).toBeUndefined();
  });

  it('keeps the rest of the safe OS/shell plumbing allowlist', () => {
    const source: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      HOME: '/home/nodal',
      TMPDIR: '/tmp',
      LANG: 'en_US.UTF-8',
      SystemRoot: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\system32\\cmd.exe',
      PATHEXT: '.COM;.EXE;.BAT',
      USERPROFILE: 'C:\\Users\\nodal',
    };

    const result = buildChildEnv(source);

    expect(result['PATH']).toBe('/usr/bin');
    expect(result['HOME']).toBe('/home/nodal');
    expect(result['TMPDIR']).toBe('/tmp');
    expect(result['LANG']).toBe('en_US.UTF-8');
    expect(result['SystemRoot']).toBe('C:\\Windows');
    expect(result['ComSpec']).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(result['PATHEXT']).toBe('.COM;.EXE;.BAT');
    expect(result['USERPROFILE']).toBe('C:\\Users\\nodal');
  });

  it('keeps interpreter/toolchain path vars a venv-based skill script needs (not secrets, just paths)', () => {
    const source: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      PYTHONPATH: '/opt/comfyui/lib',
      VIRTUAL_ENV: '/opt/comfyui/venv',
      LD_LIBRARY_PATH: '/usr/local/cuda/lib64',
      DATABASE_URL: 'postgres://user:pass@host/db',
    };

    const result = buildChildEnv(source);

    expect(result['PATH']).toBe('/usr/bin');
    expect(result['PYTHONPATH']).toBe('/opt/comfyui/lib');
    expect(result['VIRTUAL_ENV']).toBe('/opt/comfyui/venv');
    expect(result['LD_LIBRARY_PATH']).toBe('/usr/local/cuda/lib64');
    // Still a secret — presence of harmless path vars must not widen this.
    expect(result['DATABASE_URL']).toBeUndefined();
  });

  it('drops any variable not on the allowlist, even a harmless-looking one', () => {
    const source: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      MY_CUSTOM_APP_SETTING: 'whatever',
      NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org',
    };

    const result = buildChildEnv(source);

    expect(result['PATH']).toBe('/usr/bin');
    expect(result['MY_CUSTOM_APP_SETTING']).toBeUndefined();
    expect(result['NPM_CONFIG_REGISTRY']).toBeUndefined();
  });

  it('drops a secret-shaped name even if it somehow matched the allowlist (belt-and-braces)', () => {
    // ALLOWLIST is exact-name-only (SAFE_ENV_PREFIXES is just 'LC_'), so this
    // mainly exercises the denylist as an independent second gate — not a
    // realistic collision, but proves it drops on name-shape alone.
    const source: NodeJS.ProcessEnv = { PATH_TOKEN: 'leaked-if-allowlist-widens' };
    const result = buildChildEnv(source);
    expect(result['PATH_TOKEN']).toBeUndefined();
  });

  it('drops undefined-valued keys', () => {
    const source: NodeJS.ProcessEnv = { PATH: '/usr/bin', HOME: undefined };
    const result = buildChildEnv(source);
    expect(result['PATH']).toBe('/usr/bin');
    expect('HOME' in result).toBe(false);
  });
});

describe('ENV_ALLOWLIST_VERSION épingle l’allowlist (plan Vérifier & Corriger, D1)', () => {
  // L'allowlist entre dans le hash du manifeste d'une commande de preuve via
  // sa VERSION. Élargir la liste sans bumper la version laisserait une
  // approbation ancienne couvrir un environnement plus exposé. Ce snapshot
  // rougit dans ce cas : soit on bumpe ENV_ALLOWLIST_VERSION (et on ajoute la
  // nouvelle empreinte ci-dessous), soit on n'élargit pas.
  const SNAPSHOT_BY_VERSION: Record<number, string> = {
    1: 'v1:1ddc24070cacc7639ac9a7ed09ea04599ebfc8af51a7d27ef31ff9eb39771fc0',
  };

  it('la version courante a une empreinte enregistrée, et elle correspond à la liste réelle', () => {
    const expected = SNAPSHOT_BY_VERSION[ENV_ALLOWLIST_VERSION];
    expect(
      expected,
      `aucune empreinte pour ENV_ALLOWLIST_VERSION=${ENV_ALLOWLIST_VERSION}`,
    ).toBeDefined();
    const actual = `v${ENV_ALLOWLIST_VERSION}:${sha256Hex(safeEnvAllowlistSnapshot().join('\n'))}`;
    expect(actual).toBe(expected);
  });
});
