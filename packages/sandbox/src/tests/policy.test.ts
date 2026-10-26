// policy.test.ts — les dossiers inscriptibles d'une commande, les caches, et
// les dossiers permis par défaut (D3).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  NodalHomeReachError,
  TOOL_CACHE_VARIABLES,
  allowedFolderRefusal,
  broadFolderKind,
  composeAllowedFolders,
  defaultAllowedFolders,
  nodalDataFolders,
  resolveWritableRoots,
  toolCacheEnv,
  toolCacheRoot,
  type MachineView,
} from '../policy';

/** Aucun geste de l'utilisateur : la liste détectée telle quelle. */
const NO_GESTURE = { added: [], removed: [] };

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
    expect(resolveWritableRoots({ writableRoots: [ws] }, NO_GESTURE)).toEqual([
      ws,
      ...defaultRoots(),
    ]);
  });

  it('une liste vide veut dire « les dossiers par défaut seulement », jamais « partout »', () => {
    expect(resolveWritableRoots({ writableRoots: [] }, NO_GESTURE)).toEqual(defaultRoots());
  });

  it('un chemin relatif est une erreur de l’appelant, pas un chemin résolu en silence', () => {
    expect(() => resolveWritableRoots({ writableRoots: ['relative/dir'] }, NO_GESTURE)).toThrow(
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
      expect(resolveWritableRoots({ writableRoots: [link] }, NO_GESTURE)).toEqual([
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

// ─── #876 : la liste de l'espace, détectés − retirés + ajoutés ────────────────

/** Une machine fabriquée, sous `base` : un dossier personnel à elle. */
const machineAt = (env: Record<string, string | undefined> = {}): MachineView => ({
  platform: process.platform,
  home: mkdtempSync(join(base, 'home-876-')),
  env,
});

/** Les chemins que `resolveWritableRoots` déclare, résolus pour la comparaison. */
const declared = (roots: string[]): string[] => roots.map((r) => resolve(r));

describe('composeAllowedFolders — detected minus removed plus added @cap:executer-une-commande/moteur', () => {
  it('applies the gestures to what is detected on a real machine, and the opening uses that list', () => {
    const m = machineAt();
    const ollama = join(m.home, '.ollama', 'models');
    const hf = join(m.home, '.cache', 'huggingface');
    mkdirSync(ollama, { recursive: true });
    mkdirSync(hf, { recursive: true });
    const mine = mkdtempSync(join(base, 'mine-'));
    const folders = { added: [mine], removed: [hf] };

    expect(composeAllowedFolders(folders, m)).toEqual([
      { path: toolCacheRoot(), source: 'tool-cache', state: 'allowed' },
      { path: ollama, source: 'ollama', state: 'allowed' },
      { path: hf, source: 'huggingface', state: 'removed' },
      { path: mine, source: 'user', state: 'allowed' },
    ]);
    const roots = declared(resolveWritableRoots({ writableRoots: [] }, folders, { machine: m }));
    expect(roots).toContain(resolve(ollama));
    expect(roots).toContain(resolve(mine));
    expect(roots).toContain(resolve(toolCacheRoot()));
    expect(roots, 'a removed store is no longer writable').not.toContain(resolve(hf));
  });

  it('only gestures are stored: a store installed later appears on its own', () => {
    const m = machineAt();
    const none = { added: [], removed: [] };
    expect(composeAllowedFolders(none, m).map((f) => f.source)).toEqual(['tool-cache']);
    const ollama = join(m.home, '.ollama', 'models');
    mkdirSync(ollama, { recursive: true });
    expect(composeAllowedFolders(none, m)).toContainEqual({
      path: ollama,
      source: 'ollama',
      state: 'allowed',
    });
  });

  it('the tool cache is never removed, even when the stored gestures name it', () => {
    const m = machineAt();
    const folders = { added: [], removed: [toolCacheRoot()] };
    expect(composeAllowedFolders(folders, m)[0]).toEqual({
      path: toolCacheRoot(),
      source: 'tool-cache',
      state: 'allowed',
    });
    expect(
      declared(resolveWritableRoots({ writableRoots: [] }, folders, { machine: m })),
    ).toContain(resolve(toolCacheRoot()));
  });

  it('an added folder that no longer exists is shown missing, ignored at opening, and logged with a code', () => {
    const m = machineAt();
    const gone = join(base, 'gone-876');
    const logged: { code: string; fields: Record<string, unknown> }[] = [];
    const folders = { added: [gone], removed: [] };
    expect(composeAllowedFolders(folders, m)).toContainEqual({
      path: gone,
      source: 'user',
      state: 'missing',
    });
    const roots = resolveWritableRoots({ writableRoots: [] }, folders, {
      machine: m,
      log: (code, fields) => logged.push({ code, fields }),
    });
    expect(declared(roots)).not.toContain(resolve(gone));
    expect(logged).toEqual([{ code: 'SANDBOX_ALLOWED_FOLDER_MISSING', fields: { path: gone } }]);
  });

  it('a removal whose store is gone stays shown, so the gesture does not vanish', () => {
    const m = machineAt();
    const ollama = join(m.home, '.ollama', 'models');
    expect(composeAllowedFolders({ added: [], removed: [ollama] }, m)).toContainEqual({
      path: ollama,
      source: 'ollama',
      state: 'removed',
    });
  });
});

describe('allowedFolderRefusal — the data folder of Nodal can never be allowed @cap:executer-une-commande/moteur', () => {
  it('refuses the data folder itself and any folder under it, naming the folder that holds it', () => {
    const m = machineAt();
    const data = join(m.home, '.nodalai');
    mkdirSync(join(data, 'workspaces', 'e'), { recursive: true });

    const itself = allowedFolderRefusal(data, m);
    expect(itself).toBeInstanceOf(NodalHomeReachError);
    expect(itself?.code).toBe('SANDBOX_REACH_IS_NODAL_HOME');
    expect(resolve(itself!.within)).toBe(resolve(data));

    const under = allowedFolderRefusal(join(data, 'workspaces', 'e'), m);
    expect(under?.code).toBe('SANDBOX_REACH_IS_NODAL_HOME');
    expect(under?.message).toContain('is inside');
    expect(resolve(under!.within)).toBe(resolve(data));

    expect(allowedFolderRefusal(join(m.home, 'Documents'), m)).toBeNull();
  });

  it('covers this instance too when it lives elsewhere (NODALAI_HOME), not just ~/.nodalai', () => {
    const elsewhere = mkdtempSync(join(base, 'instance-876-'));
    const m = machineAt({ NODALAI_HOME: elsewhere });
    expect(allowedFolderRefusal(join(elsewhere, 'pg-data'), m)?.within).toBe(elsewhere);
    expect(nodalDataFolders(m).map((p) => resolve(p))).toContain(
      resolve(realpathSync.native(elsewhere)),
    );
  });

  it('a stored addition inside the data folder is shown refused and makes the opening fail loud', () => {
    const m = machineAt();
    const inside = join(m.home, '.nodalai', 'pg-data');
    mkdirSync(inside, { recursive: true });
    const folders = { added: [inside], removed: [] };
    expect(composeAllowedFolders(folders, m)).toContainEqual({
      path: inside,
      source: 'user',
      state: 'refused',
    });
    expect(() => resolveWritableRoots({ writableRoots: [] }, folders, { machine: m })).toThrow(
      NodalHomeReachError,
    );
  });
});

describe('broadFolderKind — what asks for a confirmation before it is allowed', () => {
  it('a drive root and the home folder are broad; any other folder is not', () => {
    const m = machineAt();
    const root = resolve('/');
    expect(dirname(root)).toBe(root);
    expect(broadFolderKind(root, m)).toBe('volume-root');
    expect(broadFolderKind(m.home, m)).toBe('home');
    expect(broadFolderKind(join(m.home, 'Documents'), m)).toBeNull();
  });
});
