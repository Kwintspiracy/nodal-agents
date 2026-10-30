// policy.test.ts — les dossiers inscriptibles d'une commande, les caches, et
// les dossiers permis par défaut (D3).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import {
  NodalHomeReachError,
  TOOL_CACHE_VARIABLES,
  allowedFolderRefusal,
  broadFolder,
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

describe('broadFolder — what asks for a confirmation before it is allowed, decided by what the folder holds @cap:executer-une-commande/moteur', () => {
  it('a volume root and the home folder are broad, and say the Nodal data they hold; any other folder is not', () => {
    const m = machineAt();
    // La racine du volume qui porte le dossier personnel (sous Windows, le
    // temporaire n'est pas toujours sur le lecteur courant).
    const root = parse(m.home).root;
    const data = join(m.home, '.nodalai');
    expect(dirname(root)).toBe(root);
    expect(broadFolder(root, m)?.kind).toBe('volume-root');
    expect(broadFolder(root, m)?.nodalData).toEqual([data]);
    expect(broadFolder(m.home, m)).toEqual({ kind: 'home', nodalData: [data] });
    expect(broadFolder(join(m.home, 'Documents'), m)).toBeNull();
  });

  it('a folder that holds the home folder asks too, on this machine', () => {
    const m = machineAt();
    expect(broadFolder(dirname(m.home), m)).toEqual({
      kind: 'holds-home',
      nodalData: [join(m.home, '.nodalai')],
    });
  });

  // Les vues ci-dessous sont celles d'AUTRES machines : la contenance se lit
  // avec les chemins de leur système, quel que soit celui qui fait tourner le
  // test (le dossier personnel « q » n'existe sur aucune).
  const windows: MachineView = { platform: 'win32', home: 'C:\\Users\\q', env: {} };
  const posix: MachineView = { platform: 'linux', home: '/home/q', env: {} };

  it('Windows view: C:\\Users holds the home and the data, the home holds the data, C:\\ is a volume root', () => {
    expect(broadFolder('C:\\Users', windows)).toEqual({
      kind: 'holds-home',
      nodalData: ['C:\\Users\\q\\.nodalai'],
    });
    expect(broadFolder('c:\\users\\Q', windows)).toEqual({
      kind: 'home',
      nodalData: ['C:\\Users\\q\\.nodalai'],
    });
    expect(broadFolder('C:\\', windows)).toEqual({
      kind: 'volume-root',
      nodalData: ['C:\\Users\\q\\.nodalai'],
    });
    expect(broadFolder('D:\\', windows)).toEqual({ kind: 'volume-root', nodalData: [] });
    expect(broadFolder('C:\\Users\\q\\Documents', windows)).toBeNull();
    expect(broadFolder('C:\\Users\\qa', windows)).toBeNull();
    expect(allowedFolderRefusal('C:\\Users\\q\\.nodalai\\pg-data', windows)?.within).toBe(
      'C:\\Users\\q\\.nodalai',
    );
  });

  it('Windows view: the parent of a moved NODALAI_HOME, and of a moved entry, holds Nodal data', () => {
    const moved: MachineView = {
      ...windows,
      env: { NODALAI_HOME: 'D:\\nodal\\inst', NODALAI_WORKSPACES_ROOT: 'E:\\ws\\nodal' },
    };
    expect(broadFolder('D:\\nodal', moved)).toEqual({
      kind: 'holds-nodal-data',
      nodalData: ['D:\\nodal\\inst'],
    });
    expect(broadFolder('E:\\ws', moved)).toEqual({
      kind: 'holds-nodal-data',
      nodalData: ['E:\\ws\\nodal'],
    });
    expect(broadFolder('D:\\work', moved)).toBeNull();
    expect(allowedFolderRefusal('D:\\nodal\\inst', moved)?.code).toBe(
      'SANDBOX_REACH_IS_NODAL_HOME',
    );
  });

  it('POSIX view: /home holds the home and the data, / is a volume root, a moved instance makes its parent broad', () => {
    expect(broadFolder('/home', posix)).toEqual({
      kind: 'holds-home',
      nodalData: ['/home/q/.nodalai'],
    });
    expect(broadFolder('/home/q', posix)).toEqual({
      kind: 'home',
      nodalData: ['/home/q/.nodalai'],
    });
    expect(broadFolder('/', posix)).toEqual({
      kind: 'volume-root',
      nodalData: ['/home/q/.nodalai'],
    });
    // Sous POSIX la casse compte : /home/Q n'est pas le dossier personnel.
    expect(broadFolder('/home/Q', posix)).toBeNull();
    const moved: MachineView = { ...posix, env: { NODALAI_HOME: '/srv/nodal/inst' } };
    expect(broadFolder('/srv/nodal', moved)).toEqual({
      kind: 'holds-nodal-data',
      nodalData: ['/srv/nodal/inst'],
    });
    expect(broadFolder('/srv/www', moved)).toBeNull();
  });
});
