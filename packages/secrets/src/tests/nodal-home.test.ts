// nodal-home.test.ts — la clé maîtresse vit dans le dossier de CETTE instance.
//
// Une seconde instance (NODALAI_HOME) qui lirait `~/.nodalai/secrets.key`
// déchiffrerait — ou pire, chiffrerait — avec la clé de la première. Le dossier
// personnel pointe dans un temporaire : la suite ne touche jamais la vraie clé.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readNodalInstances } from '@nodal-agents/shared/nodal-instances';
import { _resetMasterKeyCacheForTests, loadOrCreateMasterKey, masterKeyPath } from '../index';

let root: string;
let user: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nodal-home-secrets-'));
  user = join(root, 'user');
  vi.stubEnv('USERPROFILE', user);
  vi.stubEnv('HOME', user);
  _resetMasterKeyCacheForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  _resetMasterKeyCacheForTests();
  rmSync(root, { recursive: true, force: true });
});

describe('the master key under NODALAI_HOME', () => {
  it('is minted in the instance home, and nothing appears under the default home', () => {
    const homeB = join(root, 'nodal-b');
    vi.stubEnv('NODALAI_HOME', homeB);
    expect(masterKeyPath()).toBe(join(homeB, 'secrets.key'));
    const key = loadOrCreateMasterKey();
    expect(Buffer.from(readFileSync(join(homeB, 'secrets.key'), 'utf8'), 'base64')).toEqual(key);
    expect(existsSync(join(user, '.nodalai'))).toBe(false);
    // Declared to the other instances before the key exists (openNodalHome).
    expect(readNodalInstances(user).map((r) => r.home)).toEqual([homeB]);
  });

  it('two instances get two different keys', () => {
    vi.stubEnv('NODALAI_HOME', join(root, 'a'));
    const a = loadOrCreateMasterKey();
    _resetMasterKeyCacheForTests();
    vi.stubEnv('NODALAI_HOME', join(root, 'b'));
    const b = loadOrCreateMasterKey();
    expect(a.equals(b)).toBe(false);
  });

  it('is ~/.nodalai/secrets.key when NODALAI_HOME is not set', () => {
    vi.stubEnv('NODALAI_HOME', undefined);
    expect(masterKeyPath()).toBe(join(user, '.nodalai', 'secrets.key'));
  });

  it('a relative NODALAI_HOME is refused, never read as the default key', () => {
    vi.stubEnv('NODALAI_HOME', 'relative');
    expect(() => loadOrCreateMasterKey()).toThrow(/NODALAI_HOME must be an absolute path/);
    expect(existsSync(join(user, '.nodalai'))).toBe(false);
  });
});
