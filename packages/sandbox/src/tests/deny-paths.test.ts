// deny-paths.test.ts — les fonctions pures qui décident ce qu'une commande
// confinée peut atteindre sous le dossier de données refusé (#628, D1), sur
// tous les systèmes. L'intégration (une vraie commande MXC) est dans
// deny-data-dir.test.ts.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandboxDeniedPaths, nodalDeniedEndpoints, NodalPortsUnknown } from '../policy';

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
