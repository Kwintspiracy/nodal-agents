// deny-paths.test.ts — les fonctions pures qui décident ce qu'une commande
// confinée peut atteindre sous le dossier de données refusé (#628, D1), sur
// tous les systèmes. L'intégration (une vraie commande MXC) est dans
// deny-data-dir.test.ts.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sandboxDeniedPaths,
  readonlyTraversalRoots,
  nodalDeniedEndpoints,
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

describe('sandboxDeniedPaths', () => {
  it('refuse le dossier de données `~/.nodalai` quand il existe, résolu depuis le home réel (invariant #6)', () => {
    const home = mkdtempSync(join(tmpdir(), 'nodal-home-'));
    dirs.push(home);
    mkdirSync(join(home, '.nodalai'));
    const denied = sandboxDeniedPaths({ platform: process.platform, home, env: {} });
    expect(denied).toEqual([realpathSync.native(join(home, '.nodalai'))]);
  });

  it('ne refuse rien quand le dossier de données n’existe pas', () => {
    const home = mkdtempSync(join(tmpdir(), 'nodal-home-'));
    dirs.push(home);
    expect(sandboxDeniedPaths({ platform: process.platform, home, env: {} })).toEqual([]);
  });
});

describe('readonlyTraversalRoots', () => {
  it('re-concède le sous-dossier de TÊTE qui mène à chaque chemin sous un dossier refusé', () => {
    const root = mkdtempSync(join(tmpdir(), 'nodal-rt-'));
    dirs.push(root);
    const data = join(root, '.nodalai');
    const ws = join(data, 'workspaces', 'entity', 'ws1');
    const cache = join(data, 'tool-cache');
    const sandbox = join(data, 'sandbox');
    for (const d of [ws, cache, sandbox]) mkdirSync(d, { recursive: true });
    const denied = [realpathSync.native(data)];
    const regrants = readonlyTraversalRoots(denied, [ws, cache, sandbox]);
    const R = realpathSync.native(data);
    expect(new Set(regrants)).toEqual(
      new Set([join(R, 'workspaces'), join(R, 'tool-cache'), join(R, 'sandbox')]),
    );
  });

  it('ignore un chemin hors du dossier refusé', () => {
    const root = mkdtempSync(join(tmpdir(), 'nodal-rt-'));
    dirs.push(root);
    const data = join(root, '.nodalai');
    const outside = join(root, 'elsewhere');
    for (const d of [data, outside]) mkdirSync(d, { recursive: true });
    writeFileSync(join(outside, 'f.txt'), 'x');
    expect(readonlyTraversalRoots([realpathSync.native(data)], [outside])).toEqual([]);
  });
});
