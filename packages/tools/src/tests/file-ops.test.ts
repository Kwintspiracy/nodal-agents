// file-ops.test.ts — workspace security + 5 file_* tools (multi-workspace, Volet 5)
//
// Tests use a real fs tempdir (not pglite) — these tools are about real
// filesystem behavior, mocking fs would only test the mock.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  fileListTool,
  fileSearchTool,
} from '../builtin/file-ops';
import type { ToolContext, ToolDefinition } from '../types';
import { presentToolResult } from '../cards';
import type { z } from 'zod';

let WORKSPACE: string;
let WORKSPACE2: string;
let OUTSIDE: string;

beforeAll(async () => {
  WORKSPACE = await mkdtemp(join(tmpdir(), 'nodal-fileops-ws-'));
  WORKSPACE2 = await mkdtemp(join(tmpdir(), 'nodal-fileops-ws2-'));
  OUTSIDE = await mkdtemp(join(tmpdir(), 'nodal-fileops-outside-'));
});

afterAll(async () => {
  await rm(WORKSPACE, { recursive: true, force: true });
  await rm(WORKSPACE2, { recursive: true, force: true });
  await rm(OUTSIDE, { recursive: true, force: true });
});

beforeEach(async () => {
  // Wipe + recreate workspace contents to isolate tests.
  await rm(WORKSPACE, { recursive: true, force: true });
  await mkdir(WORKSPACE, { recursive: true });
  await rm(WORKSPACE2, { recursive: true, force: true });
  await mkdir(WORKSPACE2, { recursive: true });
});

// ─── Context helpers ──────────────────────────────────────────────────────────

/** Single-workspace context (backward-compat helper). */
function ctxWith(rootPath: string | null | undefined): ToolContext {
  return {
    jobId: '00000000-0000-0000-0000-000000000aaa',
    agentId: '00000000-0000-0000-0000-000000000bbb',
    entityId: '00000000-0000-0000-0000-000000000ccc',
    db: undefined as unknown as ToolContext['db'],
    jobChatId: null,
    workspaces:
      rootPath === null || rootPath === undefined
        ? undefined
        : rootPath.trim() === ''
          ? []
          : [{ label: 'ws', path: rootPath }],
  };
}

/** Multi-workspace context: { notes: WORKSPACE, code: WORKSPACE2 } */
function ctxMulti(): ToolContext {
  return {
    jobId: '00000000-0000-0000-0000-000000000aaa',
    agentId: '00000000-0000-0000-0000-000000000bbb',
    entityId: '00000000-0000-0000-0000-000000000ccc',
    db: undefined as unknown as ToolContext['db'],
    jobChatId: null,
    workspaces: [
      { label: 'notes', path: WORKSPACE },
      { label: 'code', path: WORKSPACE2 },
    ],
  };
}

// ─── Workspace security (single-root, unchanged semantics) ───────────────────

describe('workspace + path security', () => {
  it('fails loud when workspaces is not set', async () => {
    const r = await fileReadTool.execute({ path: 'anything.txt' }, ctxWith(null));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toContain('no workspace configured');
  });

  it('fails loud when workspace_root_path is a relative path', async () => {
    const r = await fileReadTool.execute({ path: 'x.txt' }, ctxWith('relative/path'));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toMatch(/absolute path/i);
  });

  it('rejects ../ traversal that would escape the workspace', async () => {
    await writeFile(join(OUTSIDE, 'secret.txt'), 'leaked');
    const r = await fileReadTool.execute(
      { path: '../' + resolve(OUTSIDE, 'secret.txt').slice(resolve(WORKSPACE, '..').length + 1) },
      ctxWith(WORKSPACE),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toMatch(/outside|traversal/i);
  });

  it('rejects an absolute path outside the workspace', async () => {
    await writeFile(join(OUTSIDE, 'secret.txt'), 'leaked');
    const r = await fileReadTool.execute({ path: join(OUTSIDE, 'secret.txt') }, ctxWith(WORKSPACE));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toMatch(/outside|traversal/i);
  });

  it('blocks symlinks pointing outside the workspace', async () => {
    await writeFile(join(OUTSIDE, 'secret.txt'), 'leaked');
    try {
      await symlink(join(OUTSIDE, 'secret.txt'), join(WORKSPACE, 'link.txt'));
    } catch (err) {
      // Symlink creation may require admin on Windows. Skip when blocked.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') return;
      throw err;
    }
    const r = await fileReadTool.execute({ path: 'ws/link.txt' }, ctxWith(WORKSPACE));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toMatch(/outside|traversal/i);
  });
});

// ─── Multi-workspace routing ─────────────────────────────────────────────────

describe('multi-workspace routing', () => {
  it('routes "notes/a.md" to the notes workspace', async () => {
    await writeFile(join(WORKSPACE, 'a.md'), 'notes content');
    const r = await fileReadTool.execute({ path: 'notes/a.md' }, ctxMulti());
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.content).toBe('notes content');
  });

  it('routes "code/x.ts" to the code workspace', async () => {
    await writeFile(join(WORKSPACE2, 'x.ts'), 'code content');
    const r = await fileReadTool.execute({ path: 'code/x.ts' }, ctxMulti());
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.content).toBe('code content');
  });

  it('requires a label when >1 workspace and no label given', async () => {
    const r = await fileReadTool.execute({ path: 'a.md' }, ctxMulti());
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toMatch(/workspace_label_required|label/i);
    // Error must list valid labels so the LLM can self-correct
    expect(r.reason).toContain('notes');
    expect(r.reason).toContain('code');
  });

  it('label is optional for a single-workspace agent (bare path resolves)', async () => {
    await writeFile(join(WORKSPACE, 'a.md'), 'single ws content');
    const ctx: ToolContext = {
      ...ctxMulti(),
      workspaces: [{ label: 'notes', path: WORKSPACE }],
    };
    const r = await fileReadTool.execute({ path: 'a.md' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.content).toBe('single ws content');
  });

  it('returns workspace_not_configured error when workspaces is empty', async () => {
    const ctx: ToolContext = {
      ...ctxMulti(),
      workspaces: [],
    };
    const r = await fileReadTool.execute({ path: 'notes/a.md' }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toContain('no workspace configured');
  });
});

// ─── Traversal / symlink security per root ───────────────────────────────────

describe('traversal blocked per workspace root (multi-workspace)', () => {
  it('blocks ../ traversal in notes workspace root', async () => {
    await writeFile(join(OUTSIDE, 'secret.txt'), 'leaked');
    const r = await fileReadTool.execute(
      {
        path:
          'notes/../' + resolve(OUTSIDE, 'secret.txt').slice(resolve(WORKSPACE, '..').length + 1),
      },
      ctxMulti(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toMatch(/outside|traversal/i);
  });

  it('blocks ../ traversal in code workspace root', async () => {
    await writeFile(join(OUTSIDE, 'secret.txt'), 'leaked');
    const r = await fileReadTool.execute(
      {
        path:
          'code/../' + resolve(OUTSIDE, 'secret.txt').slice(resolve(WORKSPACE2, '..').length + 1),
      },
      ctxMulti(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toMatch(/outside|traversal/i);
  });

  it('blocks symlink escape in notes workspace root (multi-workspace)', async () => {
    await writeFile(join(OUTSIDE, 'secret.txt'), 'leaked');
    try {
      await symlink(join(OUTSIDE, 'secret.txt'), join(WORKSPACE, 'link-notes.txt'));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') return;
      throw err;
    }
    const r = await fileReadTool.execute({ path: 'notes/link-notes.txt' }, ctxMulti());
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toMatch(/outside|traversal/i);
  });
});

// ─── file_read ────────────────────────────────────────────────────────────────

describe('file_read', () => {
  it('reads a file and returns content + line counts', async () => {
    await writeFile(join(WORKSPACE, 'a.txt'), 'line1\nline2\nline3');
    const r = await fileReadTool.execute({ path: 'ws/a.txt' }, ctxWith(WORKSPACE));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.content).toBe('line1\nline2\nline3');
    expect(r.total_lines).toBe(3);
    expect(r.start_line).toBe(1);
    expect(r.end_line).toBe(3);
    expect(r.truncated).toBe(false);
  });

  it('paginates with offset + limit', async () => {
    const content = Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join('\n');
    await writeFile(join(WORKSPACE, 'b.txt'), content);
    const r = await fileReadTool.execute(
      { path: 'ws/b.txt', offset: 50, limit: 10 },
      ctxWith(WORKSPACE),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.content.split('\n')).toEqual([
      'line50',
      'line51',
      'line52',
      'line53',
      'line54',
      'line55',
      'line56',
      'line57',
      'line58',
      'line59',
    ]);
    expect(r.start_line).toBe(50);
    expect(r.end_line).toBe(59);
    expect(r.truncated).toBe(true);
  });

  it('returns clean error on missing file', async () => {
    const r = await fileReadTool.execute({ path: 'ws/nope.txt' }, ctxWith(WORKSPACE));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toMatch(/not found/i);
  });
});

// ─── file_write ───────────────────────────────────────────────────────────────

describe('file_write', () => {
  it('creates a file atomically and reports bytes written', async () => {
    const r = await fileWriteTool.execute(
      { path: 'ws/new.txt', content: 'hello world', create_dirs: false },
      ctxWith(WORKSPACE),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.bytes).toBe(11);
    const onDisk = await readFile(join(WORKSPACE, 'new.txt'), 'utf8');
    expect(onDisk).toBe('hello world');
  });

  it('overwrites existing files', async () => {
    await writeFile(join(WORKSPACE, 'over.txt'), 'old');
    const r = await fileWriteTool.execute(
      { path: 'ws/over.txt', content: 'new', create_dirs: false },
      ctxWith(WORKSPACE),
    );
    expect(r.ok).toBe(true);
    const onDisk = await readFile(join(WORKSPACE, 'over.txt'), 'utf8');
    expect(onDisk).toBe('new');
  });

  it('refuses to create when parent dir missing without create_dirs', async () => {
    const r = await fileWriteTool.execute(
      { path: 'ws/nested/dir/file.txt', content: 'x', create_dirs: false },
      ctxWith(WORKSPACE),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toMatch(/create_dirs/);
  });

  it('creates missing parent dirs with create_dirs:true', async () => {
    const r = await fileWriteTool.execute(
      { path: 'ws/nested/dir/file.txt', content: 'x', create_dirs: true },
      ctxWith(WORKSPACE),
    );
    expect(r.ok).toBe(true);
    const onDisk = await readFile(join(WORKSPACE, 'nested/dir/file.txt'), 'utf8');
    expect(onDisk).toBe('x');
  });
});

// ─── file_edit ────────────────────────────────────────────────────────────────

describe('file_edit', () => {
  it('replaces a unique substring', async () => {
    await writeFile(join(WORKSPACE, 'e.txt'), 'hello world\ngoodbye world');
    const r = await fileEditTool.execute(
      { path: 'ws/e.txt', old_string: 'hello', new_string: 'salut', replace_all: false },
      ctxWith(WORKSPACE),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.replacements).toBe(1);
    const onDisk = await readFile(join(WORKSPACE, 'e.txt'), 'utf8');
    expect(onDisk).toBe('salut world\ngoodbye world');
  });

  it('fails loud on ambiguous match (without replace_all)', async () => {
    await writeFile(join(WORKSPACE, 'e.txt'), 'foo bar foo');
    const r = await fileEditTool.execute(
      { path: 'ws/e.txt', old_string: 'foo', new_string: 'baz', replace_all: false },
      ctxWith(WORKSPACE),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toMatch(/multiple|replace_all/i);
    // Original unchanged
    const onDisk = await readFile(join(WORKSPACE, 'e.txt'), 'utf8');
    expect(onDisk).toBe('foo bar foo');
  });

  it('replaces every occurrence with replace_all:true', async () => {
    await writeFile(join(WORKSPACE, 'e.txt'), 'foo bar foo baz foo');
    const r = await fileEditTool.execute(
      { path: 'ws/e.txt', old_string: 'foo', new_string: 'XX', replace_all: true },
      ctxWith(WORKSPACE),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.replacements).toBe(3);
    const onDisk = await readFile(join(WORKSPACE, 'e.txt'), 'utf8');
    expect(onDisk).toBe('XX bar XX baz XX');
  });

  it('fails loud when old_string is missing from the file', async () => {
    await writeFile(join(WORKSPACE, 'e.txt'), 'abc');
    const r = await fileEditTool.execute(
      { path: 'ws/e.txt', old_string: 'xyz', new_string: 'qqq', replace_all: false },
      ctxWith(WORKSPACE),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toMatch(/not found/i);
  });
});

// ─── file_list ────────────────────────────────────────────────────────────────

describe('file_list', () => {
  it('lists entries in a directory', async () => {
    await writeFile(join(WORKSPACE, 'a.md'), '');
    await writeFile(join(WORKSPACE, 'b.txt'), '');
    await mkdir(join(WORKSPACE, 'sub'));
    const r = await fileListTool.execute({ recursive: false, path: 'ws' }, ctxWith(WORKSPACE));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    const names = r.entries.map((e) => e.name).sort();
    expect(names).toEqual(['a.md', 'b.txt', 'sub']);
  });

  it('returns workspace labels as top-level entries when no path given', async () => {
    const r = await fileListTool.execute({ recursive: false }, ctxMulti());
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    const names = r.entries.map((e) => e.name).sort();
    expect(names).toEqual(['code', 'notes']);
    expect(r.entries.every((e) => e.type === 'dir')).toBe(true);
  });

  it('filters by glob', async () => {
    await writeFile(join(WORKSPACE, 'note.md'), '');
    await writeFile(join(WORKSPACE, 'todo.md'), '');
    await writeFile(join(WORKSPACE, 'ignore.txt'), '');
    const r = await fileListTool.execute(
      { glob: '*.md', recursive: false, path: 'ws' },
      ctxWith(WORKSPACE),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    const names = r.entries.map((e) => e.name).sort();
    expect(names).toEqual(['note.md', 'todo.md']);
  });

  it('walks subdirs when recursive:true', async () => {
    await mkdir(join(WORKSPACE, 'sub'));
    await writeFile(join(WORKSPACE, 'top.md'), '');
    await writeFile(join(WORKSPACE, 'sub/nested.md'), '');
    const r = await fileListTool.execute(
      { recursive: true, glob: '**/*.md', path: 'ws' },
      ctxWith(WORKSPACE),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    const names = r.entries.map((e) => e.name).sort();
    expect(names).toEqual(['sub/nested.md', 'top.md']);
  });
});

// ─── file_search ──────────────────────────────────────────────────────────────

describe('file_search', () => {
  it('matches content (default) and returns line + snippet', async () => {
    await writeFile(join(WORKSPACE, 'a.md'), 'first\nWINDOWS rules\nthird');
    await writeFile(join(WORKSPACE, 'b.md'), 'plain text\nno match');
    const r = await fileSearchTool.execute(
      { pattern: 'WINDOWS', target: 'content', case_sensitive: false, max_results: 100 },
      ctxWith(WORKSPACE),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.matches).toHaveLength(1);
    const m = r.matches[0]!;
    if (m.kind !== 'content') throw new Error('expected content match');
    expect(m.path).toBe('a.md');
    expect(m.line).toBe(2);
    expect(m.snippet).toBe('WINDOWS rules');
  });

  it('case-insensitive by default', async () => {
    await writeFile(join(WORKSPACE, 'a.md'), 'WINDOWS\nwindows\nWindows');
    const r = await fileSearchTool.execute(
      { pattern: 'windows', target: 'content', case_sensitive: false, max_results: 100 },
      ctxWith(WORKSPACE),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.matches).toHaveLength(3);
  });

  it('honors target:"files" for filename search', async () => {
    await writeFile(join(WORKSPACE, 'note-windows.md'), 'content');
    await writeFile(join(WORKSPACE, 'unrelated.md'), 'content');
    const r = await fileSearchTool.execute(
      { pattern: 'windows', target: 'files', case_sensitive: false, max_results: 100 },
      ctxWith(WORKSPACE),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]?.kind).toBe('file');
    if (r.matches[0]?.kind === 'file') expect(r.matches[0].path).toBe('note-windows.md');
  });

  it('skips .git and node_modules by default', async () => {
    await mkdir(join(WORKSPACE, '.git'));
    await writeFile(join(WORKSPACE, '.git/config'), 'WINDOWS in git config');
    await mkdir(join(WORKSPACE, 'node_modules'));
    await writeFile(join(WORKSPACE, 'node_modules/pkg.js'), 'WINDOWS in node_modules');
    await writeFile(join(WORKSPACE, 'real.md'), 'WINDOWS in user content');
    const r = await fileSearchTool.execute(
      { pattern: 'WINDOWS', target: 'content', case_sensitive: false, max_results: 100 },
      ctxWith(WORKSPACE),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.matches).toHaveLength(1);
    if (r.matches[0]?.kind === 'content') expect(r.matches[0].path).toBe('real.md');
  });

  it('returns invalid_regex error cleanly for malformed pattern', async () => {
    const r = await fileSearchTool.execute(
      { pattern: '(unclosed', target: 'content', case_sensitive: false, max_results: 100 },
      ctxWith(WORKSPACE),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toMatch(/regex/i);
  });

  it('searches ALL workspaces when no path given (multi-workspace)', async () => {
    await writeFile(join(WORKSPACE, 'from-notes.md'), 'SEARCH_ME_NOTES');
    await writeFile(join(WORKSPACE2, 'from-code.ts'), 'SEARCH_ME_CODE');
    const r = await fileSearchTool.execute(
      { pattern: 'SEARCH_ME', target: 'content', case_sensitive: true, max_results: 100 },
      ctxMulti(),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    // Should find matches in both workspaces
    expect(r.matches.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── P1 : la charge utile des cartes, sur de VRAIES sorties ─────────────────

type AnyTool = ToolDefinition<z.ZodTypeAny, unknown>;
const asAny = (t: unknown): AnyTool => t as AnyTool;

describe('présentation (P1) — file_write, file_read, file_list, file_search', () => {
  it('chaque sortie réelle remplit la carte déclarée ; un échec rend text sous la carte déclarée', async () => {
    const c = ctxWith(WORKSPACE);
    const wIn = { path: 'sub/a.md', content: 'bonjour\nmonde', create_dirs: true, purpose: 'test' };
    const w = await fileWriteTool.execute(wIn, c);
    expect(w.ok).toBe(true);
    const pw = presentToolResult(asAny(fileWriteTool), wIn, w);
    expect(pw).toMatchObject({ card: 'files', total: 1, truncated: false });
    expect(pw.card === 'files' && pw.files[0]).toMatchObject({ action: 'written', bytes: 13 });
    expect(pw.card === 'files' && pw.files[0]?.path).toMatch(/a\.md$/);

    const rIn = { path: 'sub/a.md' };
    const r = await fileReadTool.execute(rIn, c);
    expect(presentToolResult(asAny(fileReadTool), rIn, r)).toEqual({
      card: 'read',
      path: 'sub/a.md',
      excerpt: 'bonjour\nmonde',
      chars: 13,
      truncated: false,
      sections: 2,
    });

    const lIn = { path: 'sub', recursive: false };
    const l = await fileListTool.execute(lIn, c);
    expect(presentToolResult(asAny(fileListTool), lIn, l)).toMatchObject({
      card: 'files',
      total: 1,
      truncated: false,
      files: [{ path: 'a.md', action: 'listed', detail: 'file', bytes: 13 }],
    });

    const sIn = {
      pattern: 'monde',
      target: 'content' as const,
      case_sensitive: false,
      max_results: 100,
    };
    const sr = await fileSearchTool.execute(sIn, c);
    const ps = presentToolResult(asAny(fileSearchTool), sIn, sr);
    expect(ps).toMatchObject({ card: 'search', query: 'monde', total: 1, truncated: false });
    expect(ps.card === 'search' && ps.hits[0]).toMatchObject({
      ref: expect.stringMatching(/a\.md:2$/),
      snippet: expect.stringContaining('monde'),
    });

    // Un échec : la carte DÉCLARÉE reste `read`, la charge dit pourquoi.
    const bad = await fileReadTool.execute({ path: 'sub/absent.md' }, c);
    expect(bad.ok).toBe(false);
    const pb = presentToolResult(asAny(fileReadTool), { path: 'sub/absent.md' }, bad);
    expect(pb.card).toBe('text');
    expect(pb.card === 'text' && pb.text).toMatch(/absent\.md/);
  });
});
