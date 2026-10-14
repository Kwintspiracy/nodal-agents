// policy.test.ts — les dossiers inscriptibles d'une commande, et les caches.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOOL_CACHE_VARIABLES, resolveWritableRoots, toolCacheEnv, toolCacheRoot } from '../policy';

let base: string;
beforeAll(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'nodal-sbx-policy-')));
});
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('resolveWritableRoots', () => {
  it('les dossiers du job, puis le cache d’outils — jamais rien d’autre', () => {
    const ws = join(base, 'ws');
    mkdirSync(ws);
    expect(resolveWritableRoots({ writableRoots: [ws] })).toEqual([ws, toolCacheRoot()]);
  });

  it('une liste vide veut dire « le cache seulement », jamais « partout »', () => {
    expect(resolveWritableRoots({ writableRoots: [] })).toEqual([toolCacheRoot()]);
  });

  it('un chemin relatif est une erreur de l’appelant, pas un chemin résolu en silence', () => {
    expect(() => resolveWritableRoots({ writableRoots: ['relative/dir'] })).toThrow(
      'SANDBOX_ROOT_NOT_ABSOLUTE: relative/dir',
    );
  });

  it.runIf(process.platform === 'win32')(
    'Windows : un workspace qui est une jonction est déclaré AVEC sa cible (Windows only)',
    () => {
      const target = join(base, 'real-target');
      const link = join(base, 'junction-ws');
      mkdirSync(target);
      const made = spawnSync('cmd', ['/c', 'mklink', '/J', link, target], { windowsHide: true });
      expect(made.status).toBe(0);
      expect(resolveWritableRoots({ writableRoots: [link] })).toEqual([
        link,
        target,
        toolCacheRoot(),
      ]);
    },
  );
});

describe('toolCacheEnv', () => {
  it('chaque variable de cache pointe sous le cache de Nodal, dans un dossier qui existe', () => {
    const env = toolCacheEnv();
    expect(Object.keys(env).sort()).toEqual(Object.keys(TOOL_CACHE_VARIABLES).sort());
    for (const [name, sub] of Object.entries(TOOL_CACHE_VARIABLES)) {
      expect(env[name]).toBe(join(toolCacheRoot(), sub));
      expect(existsSync(env[name] as string)).toBe(true);
    }
  });

  it('les tests ne touchent jamais le vrai dossier personnel', () => {
    expect(process.env['NODALAI_TOOL_CACHE_ROOT']).toBeDefined();
    expect(toolCacheRoot()).toBe(process.env['NODALAI_TOOL_CACHE_ROOT']);
  });
});
