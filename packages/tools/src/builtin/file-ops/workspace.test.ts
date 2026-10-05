// workspace.test.ts — the multi-workspace path-resolution security boundary,
// plus the `windowsPathViolation` pure guard (UNC / reserved-device-name / ADS
// checks that must run BEFORE any stat() touches the filesystem).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  followLinks,
  linkTargetAsPath,
  resolveAndCheckPath,
  windowsPathViolation,
} from './workspace';
import { fileWriteTool } from './file-write';
import type { ToolContext } from '../../types';

let ROOT: string;

function ctx(workspaces: Array<{ label: string; path: string }>): ToolContext {
  return {
    jobId: '00000000-0000-0000-0000-000000000aaa',
    agentId: '00000000-0000-0000-0000-000000000bbb',
    entityId: '00000000-0000-0000-0000-000000000ccc',
    db: undefined as unknown as ToolContext['db'],
    jobChatId: null,
    workspaces,
  };
}

beforeEach(async () => {
  ROOT = await mkdtemp(join(tmpdir(), 'nodal-workspace-'));
});

afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe('windowsPathViolation — win32', () => {
  it('blocks a UNC backslash path', () => {
    expect(
      windowsPathViolation('\\\\attacker\\share\\x', '\\\\attacker\\share\\x', 'win32'),
    ).not.toBeNull();
  });

  it('blocks a UNC forward-slash (protocol-relative) path', () => {
    expect(
      windowsPathViolation('//attacker/share/x', '//attacker/share/x', 'win32'),
    ).not.toBeNull();
  });

  it('blocks a reserved device name at the end of the path (CON)', () => {
    expect(windowsPathViolation('CON', 'C:\\work\\CON', 'win32')).not.toBeNull();
  });

  it('blocks a reserved device name at the end of the path (NUL)', () => {
    expect(windowsPathViolation('NUL', 'C:\\work\\NUL', 'win32')).not.toBeNull();
  });

  it('blocks a reserved device name even with an extension (COM1.txt)', () => {
    expect(windowsPathViolation('COM1.txt', 'C:\\work\\COM1.txt', 'win32')).not.toBeNull();
  });

  it('blocks an Alternate Data Stream marker on a file', () => {
    expect(
      windowsPathViolation('file.txt:hidden', 'C:\\work\\file.txt:hidden', 'win32'),
    ).not.toBeNull();
  });

  it('blocks the ::$DATA Alternate Data Stream marker', () => {
    expect(windowsPathViolation('foo::$DATA', 'C:\\work\\foo::$DATA', 'win32')).not.toBeNull();
  });

  it('allows a normal nested file — the drive-letter colon is not an ADS marker', () => {
    expect(
      windowsPathViolation('sub/file.txt', 'C:\\workspace\\sub\\file.txt', 'win32'),
    ).toBeNull();
  });

  it('allows a normal file directly under the drive letter', () => {
    expect(windowsPathViolation('normal.txt', 'C:\\work\\normal.txt', 'win32')).toBeNull();
  });

  // R5 — device-name detection must look at the segment before the FIRST
  // dot, not just strip the last extension, so a multi-extension filename
  // routed to a device is still caught.
  it('blocks a device name with two extensions (con.txt.bak)', () => {
    expect(windowsPathViolation('con.txt.bak', 'C:\\work\\con.txt.bak', 'win32')).not.toBeNull();
  });

  it('blocks a device name with a compound extension (nul.tar.gz)', () => {
    expect(windowsPathViolation('nul.tar.gz', 'C:\\work\\nul.tar.gz', 'win32')).not.toBeNull();
  });

  // Accepted trade-off (agreed with team-lead): matching Windows' own
  // behavior over-blocks a project file whose name happens to start with a
  // device name before its first dot. Documented here so it isn't mistaken
  // for an accidental regression.
  it('(accepted trade-off) also blocks aux.config.js — Windows treats it as the AUX device too', () => {
    expect(
      windowsPathViolation('aux.config.js', 'C:\\work\\aux.config.js', 'win32'),
    ).not.toBeNull();
  });

  // R6 — device-name/ADS checks must run over requestedPath only, never over
  // lexical (which carries the trusted workspace root prefix).
  it('still blocks a device name supplied by the agent inside a subfolder', () => {
    expect(
      windowsPathViolation('sub/CON/x.txt', 'C:\\workspace\\sub\\CON\\x.txt', 'win32'),
    ).not.toBeNull();
  });

  it('still blocks/escapes a `..` traversal that reaches a device-named segment', () => {
    // Either the device-name check or the boundary check may be the one that
    // fires — both are acceptable, the point is SOME rejection happens.
    expect(windowsPathViolation('../con/x', 'C:\\Users\\x\\con\\x', 'win32')).not.toBeNull();
  });
});

describe('windowsPathViolation — linux (device names / ADS are legal there)', () => {
  it('still blocks UNC — that check is platform-independent', () => {
    expect(windowsPathViolation('//attacker/x', '//attacker/x', 'linux')).not.toBeNull();
  });

  it('allows a file literally named CON (a legal POSIX filename)', () => {
    expect(windowsPathViolation('CON', '/root/CON', 'linux')).toBeNull();
  });

  it('allows a colon in a filename (legal on POSIX, no ADS concept)', () => {
    expect(windowsPathViolation('file:name.txt', '/root/file:name.txt', 'linux')).toBeNull();
  });
});

describe('resolveAndCheckPath — UNC path is rejected before stat() ever runs', () => {
  it('throws path_traversal_blocked for a UNC path, even though nothing on disk was touched', async () => {
    await expect(
      resolveAndCheckPath(ctx([{ label: 'work', path: ROOT }]), '\\\\attacker\\share\\secret'),
    ).rejects.toMatchObject({ code: 'path_traversal_blocked' });
  });
});

describe('resolveAndCheckPath — F-23: TOCTOU hardening on the not-yet-existing suffix', () => {
  it('rejects a symlinked intermediate directory even when the final leaf does not exist yet', async () => {
    // Shape of the F-23 concern: an intermediate path segment is a symlink
    // escaping the workspace, and the final segment (the file being written)
    // does not exist yet — the normal shape of a file_write create with
    // create_dirs. The re-verification pass must still catch this via
    // realpath() on the symlinked ancestor.
    const outsideDir = await mkdtemp(join(tmpdir(), 'nodal-outside-'));
    const linkPath = join(ROOT, 'escape-link');
    try {
      await symlink(outsideDir, linkPath, 'junction');
    } catch {
      // Symlink/junction creation unsupported in this environment — the guard
      // itself is still in place; only the test fixture differs by platform.
      await rm(outsideDir, { recursive: true, force: true });
      return;
    }

    try {
      await expect(
        resolveAndCheckPath(ctx([{ label: 'work', path: ROOT }]), 'escape-link/new-file.txt'),
      ).rejects.toMatchObject({ code: 'path_traversal_blocked' });
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});

describe('resolveAndCheckPath — R6: the workspace ROOT is trusted, only the agent-supplied path is not', () => {
  it('resolves an ordinary file even when the configured workspace ROOT itself contains a "con" segment', async () => {
    // The root is something the user/admin configured (e.g. an existing
    // folder on disk that happens to be named "con"), NOT agent input. It
    // must not lock every file operation in this workspace out.
    const trickyRoot = join(ROOT, 'con', 'workspace');
    await mkdir(trickyRoot, { recursive: true });
    await writeFile(join(trickyRoot, 'readme.md'), 'hello\n', 'utf8');

    const resolved = await resolveAndCheckPath(
      ctx([{ label: 'work', path: trickyRoot }]),
      'readme.md',
    );
    expect(resolved.toLowerCase().endsWith('readme.md')).toBe(true);
  });
});

// Revue Nodal de la PR #618, passe 3, P2-1 : un lien PENDANT (symlink ou
// jonction vers une cible qui n'existe pas encore). stat() le suit, échoue, et
// la marche remontait au parent : le nom du lien n'était plus jugé que
// lexicalement, et une écriture passait au travers vers l'extérieur. Réglé ici,
// dans le résolveur que partagent file_write, file_edit, file_read, la cible
// d'un téléchargement et tous les autres usages.
describe('resolveAndCheckPath — a dangling link is followed, not read as a name (#614, review of #618)', () => {
  async function dangling(target: string, at: string): Promise<boolean> {
    try {
      await symlink(target, at, process.platform === 'win32' ? 'junction' : 'dir');
      return true;
    } catch {
      return false;
    }
  }

  it('a dangling link to a place outside every workspace is refused, and so is a path under it', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'nodal-outside-'));
    try {
      if (!(await dangling(join(outside, 'not-yet'), join(ROOT, 'x')))) return;
      const c = ctx([{ label: 'work', path: ROOT }]);
      await expect(resolveAndCheckPath(c, 'x')).rejects.toMatchObject({
        code: 'path_traversal_blocked',
      });
      await expect(resolveAndCheckPath(c, 'x/new.txt')).rejects.toMatchObject({
        code: 'path_traversal_blocked',
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('a chain of dangling links is followed to its end', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'nodal-outside-'));
    try {
      if (!(await dangling(join(ROOT, 'hop2'), join(ROOT, 'hop1')))) return;
      if (!(await dangling(join(outside, 'not-yet'), join(ROOT, 'hop2')))) return;
      await expect(
        resolveAndCheckPath(ctx([{ label: 'work', path: ROOT }]), 'hop1/new.txt'),
      ).rejects.toMatchObject({ code: 'path_traversal_blocked' });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('a dangling link to a place inside the workspace resolves there', async () => {
    const inside = join(ROOT, 'later');
    if (!(await dangling(inside, join(ROOT, 'y')))) return;
    const resolved = await resolveAndCheckPath(ctx([{ label: 'work', path: ROOT }]), 'y/new.txt');
    expect(resolved).toBe(join(await realpath(ROOT), 'later', 'new.txt'));
  });

  it('file_write refuses to write through a dangling link that leaves the workspace', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'nodal-outside-'));
    try {
      if (!(await dangling(join(outside, 'not-yet'), join(ROOT, 'x')))) return;
      const res = await fileWriteTool.execute(
        { path: 'x/new.txt', content: 'pwned', create_dirs: true },
        ctx([{ label: 'work', path: ROOT }]),
      );
      expect(res).toMatchObject({ ok: false });
      expect(JSON.stringify(res)).toContain('outside the workspace');
      await expect(stat(join(outside, 'not-yet', 'new.txt'))).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

// #669 : « /dev/null → D:/null ». `followLinks` walks UP from the path it is
// given, then glues the part that does not exist back onto the real ancestor by
// LENGTH. A rooted path with no drive (`/dev/null`, `/tmp/x`: what a Git-Bash or
// POSIX command writes, judged on Windows) was walked up as `D:\dev`, so the
// ancestor was shorter than the text it was cut from and the cut landed inside
// a word. Every caller gets the answer for the path it NAMES.
describe('followLinks: where a path really lands is the path that was named (#669)', () => {
  it.each([
    '/nodal-no-such-root/a/b',
    '/dev/null',
    '/dev/nodal-no-such/x.jpg',
    '/c/nodal-no-such/x',
    '/nodal-no-such-root/../nodal-other/a',
    '/nodal-no-such-root//a/./b',
  ])('%s resolves like the OS resolves it, never into the middle of a word', async (named) => {
    const { canonical, share } = await followLinks(named);
    expect(share).toBeNull();
    expect(canonical.toLowerCase()).toBe(resolve(named).toLowerCase());
  });

  it('a relative path is read from the working folder, whole', async () => {
    const { canonical } = await followLinks('nodal-no-such-dir/a/b.txt');
    // The working folder itself may sit behind a link (macOS): its real path.
    const expected = join(await realpath(process.cwd()), 'nodal-no-such-dir', 'a', 'b.txt');
    expect(canonical.toLowerCase()).toBe(expected.toLowerCase());
  });
});

describe('linkTargetAsPath: a link target as Windows writes it (#614, review of #618)', () => {
  it.each([
    ['\\\\?\\C:\\Users\\k\\later', 'C:\\Users\\k\\later'],
    ['\\??\\D:\\data', 'D:\\data'],
    ['\\\\?\\UNC\\fileserver\\public\\drop', '\\\\fileserver\\public\\drop'],
    ['\\\\?\\Volume{0b1c}\\x', '\\\\Volume{0b1c}\\x'],
    ['/home/k/later', '/home/k/later'],
    ['relative/dir', 'relative/dir'],
  ])('%s is %s', (raw, path) => {
    expect(linkTargetAsPath(raw)).toBe(path);
  });
});
