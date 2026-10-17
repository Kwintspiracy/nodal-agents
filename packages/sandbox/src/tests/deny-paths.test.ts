// deny-paths.test.ts — les fonctions pures qui décident ce qu'une commande
// confinée peut atteindre sous le dossier de données refusé (#628, D1), sur
// tous les systèmes. L'intégration (une vraie commande MXC) est dans
// deny-data-dir.test.ts.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { nodalInstancesDir, registerNodalInstance } from '@nodal-agents/shared/nodal-instances';
import {
  sandboxDeniedPaths,
  nodalDeniedEndpoints,
  NodalHomeReachError,
  NodalPortsUnknown,
} from '../policy';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('nodalDeniedEndpoints', () => {
  const base = { PORT: '3001', WEB_PORT: '3000', DATABASE_URL: 'postgres://u@127.0.0.1:25432/db' };

  it('refuse le runner, le web et le port Postgres de l’URL', () => {
    expect(new Set(nodalDeniedEndpoints(base).map((e) => e.port))).toEqual(
      new Set([3001, 3000, 25432]),
    );
  });

  it('prend le port Postgres PAR DÉFAUT (5432) quand l’URL n’en porte pas — jamais laissé tomber', () => {
    const ports = nodalDeniedEndpoints({ ...base, DATABASE_URL: 'postgres://u@127.0.0.1/db' }).map(
      (e) => e.port,
    );
    expect(ports).toContain(5432);
  });

  it('échoue fort (NodalPortsUnknown) si PORT, WEB_PORT ou DATABASE_URL manque ou est illisible', () => {
    for (const bad of [
      { ...base, PORT: undefined },
      { ...base, WEB_PORT: 'x' },
      { ...base, DATABASE_URL: undefined },
      { ...base, DATABASE_URL: 'not a url' },
      { ...base, DATABASE_URL: 'redis://127.0.0.1/0' },
    ]) {
      expect(() => nodalDeniedEndpoints(bad), JSON.stringify(bad)).toThrow(NodalPortsUnknown);
    }
  });
});

describe('sandboxDeniedPaths — every child of the data dir, except what the container reaches', () => {
  /** Un dossier de données comme en production. */
  function layout(): { home: string; data: string } {
    const home = mkdtempSync(join(tmpdir(), 'nodal-home-'));
    dirs.push(home);
    const data = join(home, '.nodalai');
    for (const d of ['workspaces/e/ws1', 'tool-cache', 'sandbox', 'checkpoints', 'pg-data'])
      mkdirSync(join(data, d), { recursive: true });
    writeFileSync(join(data, 'secrets.key'), 'k');
    writeFileSync(join(data, 'config.json'), '{}');
    return { home, data: realpathSync.native(data) };
  }
  const names = (paths: string[], data: string): string[] =>
    paths.map((p) => p.slice(data.length + 1)).sort();

  it('le conteneur d’une commande : tout est refusé sauf workspaces, tool-cache et sandbox', () => {
    const { home, data } = layout();
    const m = { platform: process.platform, home, env: {} };
    const reach = [
      join(data, 'workspaces', 'e', 'ws1'),
      join(data, 'tool-cache'),
      join(data, 'sandbox'),
    ];
    expect(names(sandboxDeniedPaths(reach, m), data)).toEqual([
      'checkpoints',
      'config.json',
      'pg-data',
      'secrets.key',
    ]);
  });

  it('le conteneur des checkpoints atteint aussi le magasin', () => {
    const { home, data } = layout();
    const m = { platform: process.platform, home, env: {} };
    const reach = [
      join(data, 'workspaces', 'e', 'ws1'),
      join(data, 'checkpoints'),
      join(data, 'sandbox'),
    ];
    expect(names(sandboxDeniedPaths(reach, m), data)).toEqual([
      'config.json',
      'pg-data',
      'secrets.key',
      'tool-cache',
    ]);
  });

  it('un enfant NOUVEAU est refusé sans changer de code (liste d’autorisation inversée)', () => {
    const { home, data } = layout();
    writeFileSync(join(data, 'new-secret.pem'), 'x');
    mkdirSync(join(data, 'backups'));
    const m = { platform: process.platform, home, env: {} };
    const denied = names(sandboxDeniedPaths([join(data, 'workspaces', 'e', 'ws1')], m), data);
    expect(denied).toContain('new-secret.pem');
    expect(denied).toContain('backups');
    expect(denied).not.toContain('workspaces');
  });

  it('ne refuse JAMAIS le dossier lui-même (git en fait un `stat`)', () => {
    const { home, data } = layout();
    const m = { platform: process.platform, home, env: {} };
    expect(sandboxDeniedPaths([join(data, 'workspaces', 'e', 'ws1')], m)).not.toContain(data);
  });

  it('ne refuse rien quand le dossier de données n’existe pas', () => {
    const home = mkdtempSync(join(tmpdir(), 'nodal-home-'));
    dirs.push(home);
    expect(sandboxDeniedPaths([], { platform: process.platform, home, env: {} })).toEqual([]);
  });
});

// NODALAI_HOME : deux instances sur la même machine. Celle de l'utilisateur
// dans ~/.nodalai, une seconde ailleurs. Les commandes confinées de la seconde
// ne lisent ni ses propres secrets ni ceux de la première.
describe('sandboxDeniedPaths with NODALAI_HOME — this instance and the default one', () => {
  function instance(root: string): string {
    for (const d of ['workspaces/e/ws1', 'tool-cache', 'sandbox', 'pg-data'])
      mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, 'secrets.key'), 'k');
    writeFileSync(join(root, 'config.json'), '{}');
    return realpathSync.native(root);
  }

  it('the second instance denies its own children AND the default home’s secrets', () => {
    const home = mkdtempSync(join(tmpdir(), 'nodal-home-'));
    dirs.push(home);
    const first = instance(join(home, '.nodalai'));
    const second = instance(join(home, 'nodal-b'));
    const m = { platform: process.platform, home, env: { NODALAI_HOME: second } };
    const reach = [
      join(second, 'workspaces', 'e', 'ws1'),
      join(second, 'tool-cache'),
      join(second, 'sandbox'),
    ];
    const denied = sandboxDeniedPaths(reach, m);
    expect(denied.filter((p) => p.startsWith(second + sep)).sort()).toEqual(
      ['config.json', 'pg-data', 'secrets.key'].map((c) => join(second, c)),
    );
    // The default home is not this instance's: nothing of it is reached, all
    // of it is denied — workspaces included.
    expect(denied.filter((p) => p.startsWith(first + sep)).sort()).toEqual(
      ['config.json', 'pg-data', 'sandbox', 'secrets.key', 'tool-cache', 'workspaces'].map((c) =>
        join(first, c),
      ),
    );
  });

  it('NODALAI_HOME naming the default home denies it once, not twice', () => {
    const home = mkdtempSync(join(tmpdir(), 'nodal-home-'));
    dirs.push(home);
    const first = instance(join(home, '.nodalai'));
    const m = { platform: process.platform, home, env: { NODALAI_HOME: join(home, '.nodalai') } };
    const denied = sandboxDeniedPaths([join(first, 'workspaces', 'e', 'ws1')], m);
    expect(denied).toHaveLength(new Set(denied).size);
    expect(denied.map((p) => p.slice(first.length + 1)).sort()).toEqual([
      'config.json',
      'pg-data',
      'sandbox',
      'secrets.key',
      'tool-cache',
    ]);
  });

  it('a relative NODALAI_HOME is refused, never read as ~/.nodalai', () => {
    const home = mkdtempSync(join(tmpdir(), 'nodal-home-'));
    dirs.push(home);
    instance(join(home, '.nodalai'));
    expect(() =>
      sandboxDeniedPaths([], { platform: process.platform, home, env: { NODALAI_HOME: 'b' } }),
    ).toThrow(/NODALAI_HOME must be an absolute path/);
  });
});

// Revue de #787, passe 1 : TOUTES les instances de l'utilisateur, par le registre
// (packages/shared/src/nodal-instances.ts), et les entrées déplacées hors de leur
// dossier par une variable étroite.
describe('sandboxDeniedPaths — every registered instance, and entries moved out of their home', () => {
  function instance(root: string): string {
    for (const d of ['workspaces/e/ws1', 'tool-cache', 'sandbox', 'pg-data'])
      mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, 'secrets.key'), 'k');
    writeFileSync(join(root, 'config.json'), '{}');
    return realpathSync.native(root);
  }
  function machineRoot(): string {
    const home = mkdtempSync(join(tmpdir(), 'nodal-reg-'));
    dirs.push(home);
    return realpathSync.native(home);
  }

  it('a confined command of the DEFAULT instance cannot read a registered instance’s secrets', () => {
    const home = machineRoot();
    const a = instance(join(home, '.nodalai'));
    const b = instance(join(home, 'nodal-b'));
    registerNodalInstance({ NODALAI_HOME: b }, home);
    const denied = sandboxDeniedPaths([join(a, 'workspaces', 'e', 'ws1'), join(a, 'sandbox')], {
      platform: process.platform,
      home,
      env: {},
    });
    for (const secret of ['secrets.key', 'config.json', 'pg-data'])
      expect(denied).toContain(join(b, secret));
    // A's own folders that the container reaches stay reachable.
    expect(denied).not.toContain(join(a, 'workspaces'));
    expect(denied).not.toContain(join(a, 'sandbox'));
  });

  it('an entry a narrower variable moved outside the homes is denied, for this instance and a registered one', () => {
    const home = machineRoot();
    const a = instance(join(home, '.nodalai'));
    const b = instance(join(home, 'nodal-b'));
    const bConfig = join(home, 'elsewhere-b', 'config.json');
    mkdirSync(join(home, 'elsewhere-b'));
    writeFileSync(bConfig, '{"workerSecret":"B"}');
    registerNodalInstance({ NODALAI_HOME: b, NODALAI_CONFIG_PATH: bConfig }, home);
    const aConfig = join(home, 'elsewhere-a', 'config.json');
    const aStore = join(home, 'elsewhere-a', 'checkpoints');
    const aCache = join(home, 'elsewhere-a', 'tool-cache');
    for (const d of [aStore, aCache]) mkdirSync(d, { recursive: true });
    writeFileSync(aConfig, '{"workerSecret":"A"}');
    const env = {
      NODALAI_CONFIG_PATH: aConfig,
      NODALAI_CHECKPOINTS_ROOT: aStore,
      NODALAI_TOOL_CACHE_ROOT: aCache,
    };
    const denied = sandboxDeniedPaths([join(a, 'workspaces', 'e', 'ws1'), aCache], {
      platform: process.platform,
      home,
      env,
    });
    expect(denied).toContain(bConfig);
    expect(denied).toContain(aConfig);
    // Not reached by this container: the moved store is denied whole.
    expect(denied).toContain(aStore);
    // Reached (a writable root): the moved cache stays open.
    expect(denied).not.toContain(aCache);
  });

  it('a stale entry costs nothing, a malformed one fails loud', () => {
    const home = machineRoot();
    const a = instance(join(home, '.nodalai'));
    registerNodalInstance({ NODALAI_HOME: join(home, 'gone') }, home);
    const m = { platform: process.platform, home, env: {} };
    expect(sandboxDeniedPaths([join(a, 'sandbox')], m).sort()).toEqual(
      ['config.json', 'pg-data', 'secrets.key', 'tool-cache', 'workspaces'].map((c) => join(a, c)),
    );
    writeFileSync(join(nodalInstancesDir(home), 'broken.json'), '{ not json');
    expect(() => sandboxDeniedPaths([], m)).toThrow(
      /broken\.json is not a valid Nodal instance entry/,
    );
  });
});

// Revue de #787, passe 2 : UNE règle entre « doit atteindre X » et « donnée
// d'instance D », quelle que soit leur relation — pour un dossier de Nodal comme
// pour une entrée déplacée (policy.ts, en tête de sandboxDeniedPaths).
describe('sandboxDeniedPaths — one rule for every relation between a reach and instance data', () => {
  function layout(): { home: string; a: string; b: string } {
    const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'nodal-rel-')));
    dirs.push(home);
    const a = join(home, '.nodalai');
    const b = join(home, 'proj', 'nodal-b');
    for (const root of [a, b]) {
      for (const d of ['workspaces/e/ws1', 'sandbox', 'pg-data'])
        mkdirSync(join(root, d), { recursive: true });
      writeFileSync(join(root, 'secrets.key'), 'k');
      writeFileSync(join(root, 'config.json'), '{}');
    }
    registerNodalInstance({ NODALAI_HOME: b }, home);
    return { home, a, b };
  }
  const machine = (home: string, env: Record<string, string> = {}) => ({
    platform: process.platform,
    home,
    env,
  });

  it('home, reach INSIDE it: the child it goes through stays open, the secrets stay denied', () => {
    const { home, b } = layout();
    const denied = sandboxDeniedPaths([join(b, 'workspaces', 'e', 'ws1')], machine(home));
    expect(denied).not.toContain(join(b, 'workspaces'));
    for (const c of ['secrets.key', 'config.json', 'pg-data']) expect(denied).toContain(join(b, c));
  });

  it('home, reach CONTAINING it: every child of the home is denied, the rest of the reach is not', () => {
    const { home, b } = layout();
    const denied = sandboxDeniedPaths([join(home, 'proj')], machine(home));
    expect(denied.filter((p) => p.startsWith(b + sep)).sort()).toEqual(
      ['config.json', 'pg-data', 'sandbox', 'secrets.key', 'workspaces'].map((c) => join(b, c)),
    );
    expect(denied).not.toContain(join(home, 'proj'));
  });

  it('home, reach EQUAL to it: the container is refused, named, instead of a silent choice', () => {
    const { home, b } = layout();
    expect(() => sandboxDeniedPaths([b], machine(home))).toThrow(NodalHomeReachError);
    expect(() => sandboxDeniedPaths([b], machine(home))).toThrow(
      `SANDBOX_REACH_IS_NODAL_HOME: ${b} is the home folder of a Nodal instance`,
    );
    // The current instance's own home, and the default one, follow the same rule.
    const { home: h2, a } = layout();
    expect(() => sandboxDeniedPaths([a], machine(h2))).toThrow(NodalHomeReachError);
  });

  it('moved entry: open when reached exactly or through, denied when the reach contains it', () => {
    const { home } = layout();
    const moved = join(home, 'elsewhere', 'checkpoints');
    mkdirSync(join(moved, 'store'), { recursive: true });
    const env = { NODALAI_CHECKPOINTS_ROOT: moved };
    expect(sandboxDeniedPaths([moved], machine(home, env))).not.toContain(moved);
    expect(sandboxDeniedPaths([join(moved, 'store')], machine(home, env))).not.toContain(moved);
    expect(sandboxDeniedPaths([join(home, 'elsewhere')], machine(home, env))).toContain(moved);
  });

  it('a home that no longer exists refuses nothing, even when a reach names it', () => {
    const { home } = layout();
    const gone = join(home, 'gone');
    registerNodalInstance({ NODALAI_HOME: gone }, home);
    expect(() => sandboxDeniedPaths([gone], machine(home))).not.toThrow();
  });
});
