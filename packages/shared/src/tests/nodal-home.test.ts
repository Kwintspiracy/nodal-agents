// nodal-home.test.ts — le dossier de Nodal : la variable, le défaut, les refus.
//
// Les règles sont prouvées pour les deux systèmes, quel que soit celui qui fait
// tourner la suite : `platform` est un paramètre, pas une lecture de la machine.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NodalHomeError,
  defaultNodalHome,
  ensureNodalHome,
  nodalHome,
  nodalHomeEntry,
  nodalInstanceId,
} from '../nodal-home';

describe('nodalHome', () => {
  it('is ~/.nodalai when NODALAI_HOME is not set', () => {
    expect(nodalHome({}, '/home/ada', 'linux')).toBe('/home/ada/.nodalai');
    expect(nodalHome({}, 'C:\\Users\\ada', 'win32')).toBe('C:\\Users\\ada\\.nodalai');
  });

  it('is NODALAI_HOME when it is an absolute path, normalised', () => {
    expect(nodalHome({ NODALAI_HOME: '/srv/nodal-b/' }, '/home/ada', 'linux')).toBe('/srv/nodal-b');
    expect(nodalHome({ NODALAI_HOME: 'D:/tmp/nodal-b' }, 'C:\\Users\\ada', 'win32')).toBe(
      'D:\\tmp\\nodal-b',
    );
    expect(nodalHome({ NODALAI_HOME: '\\\\nas\\share\\nodal' }, 'C:\\Users\\ada', 'win32')).toBe(
      '\\\\nas\\share\\nodal',
    );
  });

  it('refuses an empty value instead of falling back to ~/.nodalai', () => {
    for (const value of ['', '   ']) {
      expect(() => nodalHome({ NODALAI_HOME: value }, '/home/ada', 'linux')).toThrow(
        /NODALAI_HOME is set but empty/,
      );
    }
  });

  it('refuses a relative path, and a Windows path that depends on the current drive', () => {
    expect(() => nodalHome({ NODALAI_HOME: 'nodal-b' }, '/home/ada', 'linux')).toThrow(
      /NODALAI_HOME must be an absolute path, got "nodal-b"/,
    );
    expect(() => nodalHome({ NODALAI_HOME: './b' }, 'C:\\Users\\ada', 'win32')).toThrow(
      NodalHomeError,
    );
    expect(() => nodalHome({ NODALAI_HOME: '\\nodal-b' }, 'C:\\Users\\ada', 'win32')).toThrow(
      /must be an absolute path/,
    );
    expect(() => nodalHome({ NODALAI_HOME: 'C:nodal-b' }, 'C:\\Users\\ada', 'win32')).toThrow(
      /must be an absolute path/,
    );
  });
});

describe('nodalHomeEntry — the narrower variables keep their precedence', () => {
  const cases = [
    ['config.json', 'NODALAI_CONFIG_PATH'],
    ['workspaces', 'NODALAI_WORKSPACES_ROOT'],
    ['checkpoints', 'NODALAI_CHECKPOINTS_ROOT'],
    ['sandbox', 'NODALAI_SANDBOX_DIR'],
    ['tool-cache', 'NODALAI_TOOL_CACHE_ROOT'],
  ] as const;

  it.each(cases)('%s follows NODALAI_HOME when %s is not set', (entry) => {
    expect(nodalHomeEntry(entry, { NODALAI_HOME: '/srv/b' }, '/home/ada', 'linux')).toBe(
      `/srv/b/${entry}`,
    );
    expect(nodalHomeEntry(entry, {}, '/home/ada', 'linux')).toBe(`/home/ada/.nodalai/${entry}`);
  });

  it.each(cases)('%s goes where %s says, whatever NODALAI_HOME says', (entry, variable) => {
    expect(
      nodalHomeEntry(entry, { NODALAI_HOME: '/srv/b', [variable]: '/elsewhere/x' }, '/h', 'linux'),
    ).toBe('/elsewhere/x');
  });

  it.each(cases)('%s refuses a relative %s, like NODALAI_HOME', (entry, variable) => {
    expect(() => nodalHomeEntry(entry, { [variable]: 'rel' }, '/h', 'linux')).toThrow(
      new RegExp(`${variable} must be an absolute path`),
    );
  });
});

describe('ensureNodalHome', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nodal-home-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('creates the folder, parents included', () => {
    const dir = join(tmp, 'a', 'b', 'home');
    expect(ensureNodalHome(dir)).toBe(dir);
    expect(statSync(dir).isDirectory()).toBe(true);
  });

  it('refuses, naming the folder and the variable, when a file is in the way', () => {
    const file = join(tmp, 'occupied');
    writeFileSync(file, 'x');
    let caught: unknown;
    try {
      ensureNodalHome(join(file, 'home'));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NodalHomeError);
    expect((caught as Error).message).toContain(join(file, 'home'));
    expect((caught as Error).message).toContain('NODALAI_HOME');
    expect(existsSync(join(file, 'home'))).toBe(false);
  });
});

describe('nodalInstanceId', () => {
  it('is null for the default home, whatever its spelling on Windows', () => {
    expect(nodalInstanceId('/home/ada/.nodalai', '/home/ada', 'linux')).toBeNull();
    expect(nodalInstanceId('c:\\users\\ADA\\.NodalAI\\', 'C:\\Users\\ada', 'win32')).toBeNull();
  });

  it('is stable for one home and distinct between two', () => {
    const a = nodalInstanceId('/srv/a', '/home/ada', 'linux');
    const b = nodalInstanceId('/srv/b', '/home/ada', 'linux');
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(nodalInstanceId('/srv/a/', '/home/ada', 'linux')).toBe(a);
    expect(b).not.toBe(a);
    expect(nodalInstanceId('D:\\Tmp\\A', 'C:\\Users\\ada', 'win32')).toBe(
      nodalInstanceId('d:\\tmp\\a', 'C:\\Users\\ada', 'win32'),
    );
  });

  it('treats the default home as the default even when NODALAI_HOME names it', () => {
    const home = defaultNodalHome('/home/ada', 'linux');
    expect(
      nodalInstanceId(
        nodalHome({ NODALAI_HOME: home }, '/home/ada', 'linux'),
        '/home/ada',
        'linux',
      ),
    ).toBeNull();
  });
});
