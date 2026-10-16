// policy.test.ts — les dossiers inscriptibles d'une commande, les caches, et
// les dossiers permis par défaut (D3).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TOOL_CACHE_VARIABLES,
  defaultAllowedFolders,
  resolveWritableRoots,
  toolCacheEnv,
  toolCacheRoot,
  type MachineView,
} from '../policy';

let base: string;
beforeAll(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'nodal-sbx-policy-')));
});
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

/**
 * Les dossiers permis par défaut de CETTE machine, tels que déclarés : chaque
 * chemin, et son chemin RÉSOLU quand il diffère. Sur le runner Windows de
 * GitHub, le temporaire s'écrit en nom court 8.3 (`RUNNER~1`), et la
 * résolution le rallonge.
 */
const defaultRoots = (): string[] => {
  const out: string[] = [];
  for (const f of defaultAllowedFolders()) {
    out.push(f.path);
    const real = realpathSync.native(f.path);
    if (real !== f.path) out.push(real);
  }
  return out;
};

describe('resolveWritableRoots', () => {
  it('les dossiers du job, puis les dossiers permis par défaut — jamais rien d’autre', () => {
    const ws = join(base, 'ws');
    mkdirSync(ws);
    expect(resolveWritableRoots({ writableRoots: [ws] })).toEqual([ws, ...defaultRoots()]);
  });

  it('une liste vide veut dire « les dossiers par défaut seulement », jamais « partout »', () => {
    expect(resolveWritableRoots({ writableRoots: [] })).toEqual(defaultRoots());
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
        ...defaultRoots(),
      ]);
    },
  );
});

describe('defaultAllowedFolders (D3)', () => {
  /** Une machine fabriquée : un dossier personnel à nous, des variables à nous. */
  const fakeMachine = (
    platform: NodeJS.Platform,
    env: Record<string, string | undefined> = {},
  ): MachineView => {
    const home = mkdtempSync(join(base, `home-${platform}-`));
    return { platform, home, env };
  };

  it('le cache d’outils de Nodal vient en tête, et existe', () => {
    const m = fakeMachine('linux');
    const folders = defaultAllowedFolders(m);
    expect(folders[0]).toEqual({ path: toolCacheRoot(), source: 'tool-cache' });
    expect(existsSync(toolCacheRoot())).toBe(true);
  });

  it('rien n’est inventé : sur une machine sans ces programmes, seul le cache d’outils', () => {
    expect(defaultAllowedFolders(fakeMachine('linux'))).toEqual([
      { path: toolCacheRoot(), source: 'tool-cache' },
    ]);
    expect(defaultAllowedFolders(fakeMachine('darwin'))).toEqual([
      { path: toolCacheRoot(), source: 'tool-cache' },
    ]);
  });

  it('les emplacements par défaut, quand ils existent : Ollama, Hugging Face, Docker (Linux sans root)', () => {
    const m = fakeMachine('linux');
    const ollama = join(m.home, '.ollama', 'models');
    const hf = join(m.home, '.cache', 'huggingface');
    const docker = join(m.home, '.local', 'share', 'docker');
    for (const d of [ollama, hf, docker]) mkdirSync(d, { recursive: true });
    expect(defaultAllowedFolders(m)).toEqual([
      { path: toolCacheRoot(), source: 'tool-cache' },
      { path: ollama, source: 'ollama' },
      { path: hf, source: 'huggingface' },
      { path: docker, source: 'docker' },
    ]);
  });

  it('la configuration du programme passe avant l’emplacement par défaut : OLLAMA_MODELS, HF_HOME, HF_HUB_CACHE', () => {
    const elsewhere = mkdtempSync(join(base, 'stores-'));
    const models = join(elsewhere, 'ollama-models');
    const hfHome = join(elsewhere, 'hf-home');
    const hubCache = join(elsewhere, 'hf-hub');
    for (const d of [models, hfHome, hubCache]) mkdirSync(d);
    const m = fakeMachine('linux', {
      OLLAMA_MODELS: models,
      HF_HOME: hfHome,
      HF_HUB_CACHE: hubCache,
    });
    // L'emplacement par défaut existe aussi : il n'est PAS pris, la variable gagne.
    mkdirSync(join(m.home, '.ollama', 'models'), { recursive: true });
    expect(defaultAllowedFolders(m)).toEqual([
      { path: toolCacheRoot(), source: 'tool-cache' },
      { path: models, source: 'ollama' },
      { path: hfHome, source: 'huggingface' },
      { path: hubCache, source: 'huggingface' },
    ]);
  });

  it('ComfyUI Desktop : les modèles et les images du dossier que SA configuration nomme (Windows)', () => {
    const appData = mkdtempSync(join(base, 'appdata-'));
    const comfyBase = mkdtempSync(join(base, 'comfy-'));
    mkdirSync(join(appData, 'ComfyUI'));
    writeFileSync(
      join(appData, 'ComfyUI', 'config.json'),
      JSON.stringify({ installState: 'installed', basePath: comfyBase }),
    );
    mkdirSync(join(comfyBase, 'models'));
    mkdirSync(join(comfyBase, 'output'));
    const localAppData = mkdtempSync(join(base, 'localappdata-'));
    mkdirSync(join(localAppData, 'Docker', 'wsl'), { recursive: true });
    const m = fakeMachine('win32', { APPDATA: appData, LOCALAPPDATA: localAppData });
    expect(defaultAllowedFolders(m)).toEqual([
      { path: toolCacheRoot(), source: 'tool-cache' },
      { path: join(comfyBase, 'models'), source: 'comfyui' },
      { path: join(comfyBase, 'output'), source: 'comfyui' },
      { path: join(localAppData, 'Docker', 'wsl'), source: 'docker' },
    ]);
  });

  it('une configuration ComfyUI illisible ou sans dossier absolu ne fait rien deviner', () => {
    const appData = mkdtempSync(join(base, 'appdata-bad-'));
    mkdirSync(join(appData, 'ComfyUI'));
    writeFileSync(join(appData, 'ComfyUI', 'config.json'), '{"basePath": "relative/comfy"}');
    const m = fakeMachine('win32', { APPDATA: appData });
    expect(defaultAllowedFolders(m)).toEqual([{ path: toolCacheRoot(), source: 'tool-cache' }]);
  });
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
