// workspace.test.ts — the multi-workspace path-resolution security boundary,
// plus the `windowsPathViolation` pure guard (UNC / reserved-device-name / ADS
// checks that must run BEFORE any stat() touches the filesystem).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAndCheckPath, windowsPathViolation } from './workspace';
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
