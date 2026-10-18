// nodal-home.test.mjs — les scripts du dépôt résolvent le dossier de Nodal par
// la règle du produit (scripts/lib/nodal-home.mjs), et pas par une copie.
//
// Le cas qui compte se lance dans un VRAI `node`, pas sous vitest : c'est Node
// lui-même qui doit retirer les types de packages/shared/src/nodal-home.ts
// quand `pnpm release:check` ou `pnpm bench:studio` le chargent.

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedNodalEnv } from '../lib/nodal-home.mjs';
import { configHoteDepuis, portsDeLaStack } from '../lib/live-stack.mjs';

const repo = resolve(fileURLToPath(import.meta.url), '..', '..', '..');

function nodeResolves(env) {
  const code =
    "import('./scripts/lib/nodal-home.mjs').then((m) => process.stdout.write(m.nodalHomeEntry('config.json')))";
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: repo,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
}

describe('repo scripts and NODALAI_HOME', () => {
  it('a plain node run reads the config.json of the home NODALAI_HOME names', () => {
    const home = resolve(repo, '..', 'some-nodal-home');
    const r = nodeResolves({ NODALAI_HOME: home, NODALAI_CONFIG_PATH: '' });
    // NODALAI_CONFIG_PATH='' is set-but-empty: refused, not ignored.
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/NODALAI_CONFIG_PATH is set but empty/);

    const ok = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import('./scripts/lib/nodal-home.mjs').then((m) => process.stdout.write(m.nodalHomeEntry('config.json')))",
      ],
      {
        cwd: repo,
        env: { ...isolatedNodalEnv(process.env, repo), NODALAI_HOME: home },
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    expect(ok.stderr).not.toMatch(/Error/);
    expect(ok.stdout).toBe(join(home, 'config.json'));
  });

  it('a relative NODALAI_HOME stops the script, never falls back to ~/.nodalai', () => {
    const r = nodeResolves({ NODALAI_HOME: 'relative-home' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/NODALAI_HOME must be an absolute path, got "relative-home"/);
  });

  it('a smoke child lives under its own home, the developer’s narrower variables removed', () => {
    const env = isolatedNodalEnv(
      { PATH: 'p', NODALAI_HOME: '/dev/own', NODALAI_WORKSPACES_ROOT: '/dev/ws' },
      join(repo, 'h'),
    );
    expect(env).toEqual({
      PATH: 'p',
      HOME: join(repo, 'h'),
      USERPROFILE: join(repo, 'h'),
      NODALAI_HOME: join(repo, 'h', '.nodalai'),
    });
  });

  it('the stack guard names the file it actually read', () => {
    const file = join(repo, 'h', 'config.json');
    expect(() => configHoteDepuis({ texte: '{', chemin: file })).toThrow(`cannot parse ${file}`);
    expect(() => portsDeLaStack({ ports: { web: 'x' } }, file)).toThrow(`in ${file} is not a port`);
  });
});
