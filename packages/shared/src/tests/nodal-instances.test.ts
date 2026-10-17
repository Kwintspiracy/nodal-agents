// nodal-instances.test.ts — le registre des instances : un fichier par dossier,
// relu tel quel, retiré par son instance, et jamais ignoré en silence.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NodalInstancesError,
  nodalInstancesDir,
  openNodalHome,
  readNodalInstances,
  registerNodalInstance,
  unregisterNodalInstance,
} from '../nodal-instances';

let user: string;
beforeEach(() => {
  user = mkdtempSync(join(tmpdir(), 'nodal-instances-'));
});
afterEach(() => rmSync(user, { recursive: true, force: true }));

const NOW = new Date('2026-10-18T00:00:00.000Z');

describe('the instance registry', () => {
  it('records the home and the resolved entries, one file per instance', () => {
    const b = join(user, 'nodal-b');
    const cfg = join(user, 'cfg', 'config.json');
    registerNodalInstance({}, user, process.platform, NOW);
    registerNodalInstance(
      { NODALAI_HOME: b, NODALAI_CONFIG_PATH: cfg },
      user,
      process.platform,
      NOW,
    );
    // Registering again replaces the entry, it does not add one.
    registerNodalInstance(
      { NODALAI_HOME: b, NODALAI_CONFIG_PATH: cfg },
      user,
      process.platform,
      NOW,
    );

    expect(readdirSync(nodalInstancesDir(user))).toHaveLength(2);
    const byHome = new Map(readNodalInstances(user).map((r) => [r.home, r]));
    expect(byHome.get(join(user, '.nodalai'))?.entries.workspaces).toBe(
      join(user, '.nodalai', 'workspaces'),
    );
    expect(byHome.get(b)).toEqual({
      home: b,
      entries: {
        'config.json': cfg,
        workspaces: join(b, 'workspaces'),
        checkpoints: join(b, 'checkpoints'),
        sandbox: join(b, 'sandbox'),
        'tool-cache': join(b, 'tool-cache'),
      },
      registeredAt: NOW.toISOString(),
    });
  });

  it('is empty when nothing ever registered, and lives outside every Nodal home', () => {
    expect(readNodalInstances(user)).toEqual([]);
    expect(nodalInstancesDir(user)).toBe(join(user, '.nodalai-instances'));
  });

  it('removes only the entry of the instance that unregisters', () => {
    const b = join(user, 'nodal-b');
    registerNodalInstance({}, user);
    registerNodalInstance({ NODALAI_HOME: b }, user);
    unregisterNodalInstance({ NODALAI_HOME: b }, user);
    expect(readNodalInstances(user).map((r) => r.home)).toEqual([join(user, '.nodalai')]);
    unregisterNodalInstance({ NODALAI_HOME: b }, user);
  });

  it('refuses a malformed entry, naming the file, instead of skipping it', () => {
    registerNodalInstance({}, user);
    const bad = join(nodalInstancesDir(user), 'bad.json');
    writeFileSync(bad, JSON.stringify({ home: 'relative', entries: {}, registeredAt: 'x' }));
    expect(() => readNodalInstances(user)).toThrow(NodalInstancesError);
    expect(() => readNodalInstances(user)).toThrow(bad);
  });

  it('refuses to register an instance whose home is not absolute, and writes nothing', () => {
    expect(() => registerNodalInstance({ NODALAI_HOME: 'rel' }, user)).toThrow(
      /NODALAI_HOME must be an absolute path/,
    );
    expect(existsSync(nodalInstancesDir(user))).toBe(false);
  });

  it('says why it cannot register, instead of carrying on unregistered', () => {
    writeFileSync(join(user, '.nodalai-instances'), 'a file in the way');
    expect(() => registerNodalInstance({}, user)).toThrow(/Cannot register this instance/);
  });

  it('openNodalHome declares the instance BEFORE creating its home', () => {
    const b = join(user, 'nodal-b');
    expect(openNodalHome({ NODALAI_HOME: b }, user)).toBe(b);
    expect(existsSync(b)).toBe(true);
    expect(readNodalInstances(user).map((r) => r.home)).toEqual([b]);

    // A home that cannot be created is still declared: a stale entry costs
    // nothing, undeclared data would be readable by the others.
    writeFileSync(join(user, 'occupied'), 'x');
    const c = join(user, 'occupied', 'home');
    expect(() => openNodalHome({ NODALAI_HOME: c }, user)).toThrow(/cannot be created/);
    expect(readNodalInstances(user).map((r) => r.home)).toContain(c);
  });
});
