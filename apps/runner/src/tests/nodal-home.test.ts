// nodal-home.test.ts — ce que le runner range sur le disque suit NODALAI_HOME.
//
// Le CLI passe au runner le dossier de son instance (`NODALAI_HOME`, env.ts).
// Chaque dossier que le runner calcule — workspaces, magasin des skills,
// checkpoints, hôte du bac à sable, caches d'outils — doit alors tomber sous ce
// dossier, et rien sous celui de l'instance par défaut. Les variables étroites
// gardent la priorité sur leur seul sous-dossier.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspacesRoot } from '@nodal-agents/tools';
import { checkpointsRoot } from '@nodal-agents/checkpoints';
import { sandboxHostDir, toolCacheEnv, toolCacheRoot } from '@nodal-agents/sandbox';
import { skillStoreDir } from '../skills/store-dir.ts';

const NARROW = [
  'NODALAI_WORKSPACES_ROOT',
  'NODALAI_CHECKPOINTS_ROOT',
  'NODALAI_SANDBOX_DIR',
  'NODALAI_TOOL_CACHE_ROOT',
];

let root: string;
let user: string;
let homeB: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nodal-home-runner-'));
  user = join(root, 'user');
  homeB = join(root, 'nodal-b');
  vi.stubEnv('USERPROFILE', user);
  vi.stubEnv('HOME', user);
  vi.stubEnv('NODALAI_HOME', homeB);
  // La suite pose ces variables vers des temporaires (setup-workspaces-root) :
  // ici on prouve ce qui se passe SANS elles.
  for (const v of NARROW) vi.stubEnv(v, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('runner folders under NODALAI_HOME', () => {
  it('workspaces, skill store, checkpoints, sandbox host and tool caches all land in the home', () => {
    expect(workspacesRoot()).toBe(join(homeB, 'workspaces'));
    expect(skillStoreDir('e1')).toBe(join(homeB, 'workspaces', 'e1', 'skills'));
    expect(skillStoreDir(null)).toBe(join(homeB, 'workspaces', '_system', 'skills'));
    expect(checkpointsRoot()).toBe(join(homeB, 'checkpoints'));
    expect(sandboxHostDir()).toBe(join(homeB, 'sandbox'));
    expect(toolCacheRoot()).toBe(join(homeB, 'tool-cache'));

    // toolCacheEnv CRÉE ses dossiers : ils existent sous B, et rien sous le défaut.
    const env = toolCacheEnv();
    expect(env['npm_config_cache']).toBe(join(homeB, 'tool-cache', 'npm'));
    expect(existsSync(join(homeB, 'tool-cache', 'npm'))).toBe(true);
    expect(existsSync(join(user, '.nodalai'))).toBe(false);
  });

  it('a narrower variable still moves its own folder, and only that one', () => {
    const ws = join(root, 'elsewhere-ws');
    vi.stubEnv('NODALAI_WORKSPACES_ROOT', ws);
    expect(workspacesRoot()).toBe(ws);
    expect(skillStoreDir('e1')).toBe(join(ws, 'e1', 'skills'));
    expect(checkpointsRoot()).toBe(join(homeB, 'checkpoints'));
  });

  it('without NODALAI_HOME, the same folders are under ~/.nodalai', () => {
    vi.stubEnv('NODALAI_HOME', undefined);
    expect(workspacesRoot()).toBe(join(user, '.nodalai', 'workspaces'));
    expect(checkpointsRoot()).toBe(join(user, '.nodalai', 'checkpoints'));
  });
});
