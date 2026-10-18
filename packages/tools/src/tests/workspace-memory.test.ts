// workspace-memory.test.ts — the project instructions Nodal reads for Claude,
// on REAL files in a throwaway tree.
//
// Since #782 Claude is launched with `--setting-sources user`, which also stops
// it from loading the folder's CLAUDE.md files (measured on claude 2.1.301).
// Nodal reads them itself and hands them over as text. What these tests pin is
// the part that could leak or mislead: which files, in which order, where the
// read stops, what an import may reach, and that a cut is never silent.
//
// Mutations verified (each reverted afterwards): the lexical import gate
// removed → the outside-import tests red; the realpath gate removed → the
// junction tests red; the upper bound removed (walk to the disk root) → the
// bound test red; the cycle set removed → the cycle test red.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findImportTokens,
  readWorkspaceMemory,
  WORKSPACE_MEMORY_MAX_IMPORT_DEPTH,
} from '../builtin/code-task/workspace-memory';

let base: string;
let logs: string[];
const log = (m: string): void => {
  logs.push(m);
};

beforeEach(async () => {
  // realpath: on Windows tmpdir() is the 8.3 short form, the reader the long one.
  base = await realpath(await mkdtemp(join(tmpdir(), 'nodal-wsmem-')));
  logs = [];
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function put(rel: string, content: string): Promise<string> {
  const p = join(base, rel);
  await mkdir(join(p, '..'), { recursive: true });
  await writeFile(p, content);
  return p;
}

const read = (cwd: string, roots: string[], extra: { maxBytes?: number } = {}) =>
  readWorkspaceMemory({ cwd, roots, log, ...extra });

describe('readWorkspaceMemory — which files, which order, where it stops @cap:travailler-sur-des-fichiers/moteur', () => {
  it('reads each folder from the root down to the cwd, the closest last, local file last in its folder', async () => {
    const root = join(base, 'repo');
    await put('repo/CLAUDE.md', 'ROOT-MD');
    await put('repo/.claude/CLAUDE.md', 'ROOT-DOT');
    await put('repo/.claude/rules/b.md', 'RULE-B');
    await put('repo/.claude/rules/a.md', 'RULE-A');
    await put('repo/.claude/rules/nested/c.md', 'RULE-C');
    await put('repo/CLAUDE.local.md', 'ROOT-LOCAL');
    await put('repo/sub/CLAUDE.md', 'SUB-MD');
    await put('repo/sub/CLAUDE.local.md', 'SUB-LOCAL');
    await put('repo/sub/deeper/CLAUDE.md', 'DEEPER-MD');

    const mem = await read(join(root, 'sub', 'deeper'), [root]);

    expect(mem?.files.map((f) => f.path)).toEqual([
      'CLAUDE.md',
      '.claude/CLAUDE.md',
      '.claude/rules/a.md',
      '.claude/rules/b.md',
      '.claude/rules/nested/c.md',
      'CLAUDE.local.md',
      'sub/CLAUDE.md',
      'sub/CLAUDE.local.md',
      'sub/deeper/CLAUDE.md',
    ]);
    // And the text really carries them, in that order.
    const text = mem!.text;
    const at = [
      'ROOT-MD',
      'ROOT-DOT',
      'RULE-A',
      'RULE-B',
      'RULE-C',
      'ROOT-LOCAL',
      'SUB-MD',
      'SUB-LOCAL',
      'DEEPER-MD',
    ].map((w) => text.indexOf(w));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
  });

  it('never reads above the root, nor below the cwd', async () => {
    await put('CLAUDE.md', 'ABOVE-THE-ROOT');
    await put('repo/CLAUDE.md', 'ROOT-MD');
    await put('repo/sub/CLAUDE.md', 'BELOW-THE-CWD');
    const mem = await read(join(base, 'repo'), [join(base, 'repo')]);
    expect(mem?.text).toContain('ROOT-MD');
    expect(mem?.text).not.toContain('ABOVE-THE-ROOT');
    expect(mem?.text).not.toContain('BELOW-THE-CWD');
  });

  it('the root that bounds the read is the deepest attached folder containing the cwd', async () => {
    await put('repo/CLAUDE.md', 'OUTER');
    await put('repo/inner/CLAUDE.md', 'INNER');
    const mem = await read(join(base, 'repo', 'inner'), [
      join(base, 'repo'),
      join(base, 'repo', 'inner'),
    ]);
    expect(mem?.text).toContain('INNER');
    expect(mem?.text).not.toContain('OUTER');
  });

  it('a cwd outside every attached folder is an error, not a guess', async () => {
    await mkdir(join(base, 'elsewhere'), { recursive: true });
    await mkdir(join(base, 'repo'), { recursive: true });
    await expect(read(join(base, 'elsewhere'), [join(base, 'repo')])).rejects.toThrow(
      /workspace_memory_cwd_outside_roots/,
    );
  });

  it('no instructions anywhere is null, not an empty block', async () => {
    await mkdir(join(base, 'repo'), { recursive: true });
    expect(await read(join(base, 'repo'), [join(base, 'repo')])).toBeNull();
  });

  it('quotes the content verbatim, in a wrapper made of attributes only', async () => {
    const body = 'Always answer in French.\nUse tabs, <b>not</b> spaces & "quotes".';
    await put('repo/CLAUDE.md', body);
    const mem = await read(join(base, 'repo'), [join(base, 'repo')]);
    expect(mem?.text).toBe(
      `<project-instructions source="workspace files, quoted verbatim">\n<file path="CLAUDE.md">\n${body}\n</file>\n</project-instructions>`,
    );
  });

  it('skips a file with a NUL byte and says so', async () => {
    await put('repo/CLAUDE.md', 'TEXT');
    await mkdir(join(base, 'repo', '.claude'), { recursive: true });
    await writeFile(join(base, 'repo', '.claude', 'CLAUDE.md'), Buffer.from([65, 0, 66]));
    const mem = await read(join(base, 'repo'), [join(base, 'repo')]);
    expect(mem?.files.map((f) => f.path)).toEqual(['CLAUDE.md']);
    expect(mem?.notes.map((n) => n.kind)).toEqual(['file_binary']);
    expect(logs.join('\n')).toContain('file_binary');
  });
});

describe('readWorkspaceMemory — imports stay inside the folder @cap:travailler-sur-des-fichiers/moteur', () => {
  it('follows an import inside the folder, relative to the file that holds it', async () => {
    await put('repo/docs/CLAUDE.md', 'See @details.md and @../shared/style.md');
    await put('repo/docs/details.md', 'DETAILS-HERE');
    await put('repo/shared/style.md', 'STYLE-HERE');
    // details.md exists ONLY relative to the importing file, not to the cwd or the root.
    const mem = await read(join(base, 'repo', 'docs'), [join(base, 'repo')]);
    expect(mem?.files).toEqual([
      { path: 'docs/CLAUDE.md', bytes: expect.any(Number) },
      { path: 'docs/details.md', importedFrom: 'docs/CLAUDE.md', bytes: 12 },
      { path: 'shared/style.md', importedFrom: 'docs/CLAUDE.md', bytes: 10 },
    ]);
    expect(mem?.text).toContain('<file path="docs/details.md" imported-from="docs/CLAUDE.md">');
    expect(mem?.text).toContain('DETAILS-HERE');
  });

  it('never reads an import that points outside the folder: relative, absolute or home', async () => {
    const secret = await put('outside/secret.md', 'TOP-SECRET-OUTSIDE');
    await put(
      'repo/CLAUDE.md',
      [
        `@../outside/secret.md`,
        `@${secret.replace(/\\/g, '/')}`,
        '@~/outside/secret.md',
        'END',
      ].join('\n'),
    );
    const mem = await read(join(base, 'repo'), [join(base, 'repo')]);
    expect(mem?.text).not.toContain('TOP-SECRET-OUTSIDE');
    expect(mem?.files.map((f) => f.path)).toEqual(['CLAUDE.md']);
    // The import line stays in the text as written, and each refusal is logged.
    expect(mem?.text).toContain('@../outside/secret.md');
    expect(mem?.notes.filter((n) => n.kind === 'import_outside_root').map((n) => n.path)).toEqual([
      '../outside/secret.md',
      secret.replace(/\\/g, '/'),
      '~/outside/secret.md',
    ]);
    expect(logs.filter((l) => l.includes('import_outside_root'))).toHaveLength(3);
  });

  it('never reads an import that LOOKS inside but resolves outside through a link', async () => {
    await put('outside/secret.md', 'TOP-SECRET-VIA-LINK');
    await mkdir(join(base, 'repo'), { recursive: true });
    // A junction on Windows (no privilege needed), a symlink elsewhere: the folder
    // is "inside" on paper, and its real path is not.
    await symlink(join(base, 'outside'), join(base, 'repo', 'link'), 'junction');
    await put('repo/CLAUDE.md', 'Read @link/secret.md');
    const mem = await read(join(base, 'repo'), [join(base, 'repo')]);
    expect(mem?.text).not.toContain('TOP-SECRET-VIA-LINK');
    expect(mem?.notes.map((n) => n.kind)).toEqual(['import_outside_root']);
  });

  it('refuses a CLAUDE.md itself when its folder is a link leading out', async () => {
    await put('outside/CLAUDE.md', 'PLANTED-THROUGH-DOT-CLAUDE');
    await mkdir(join(base, 'repo'), { recursive: true });
    await symlink(join(base, 'outside'), join(base, 'repo', '.claude'), 'junction');
    await put('repo/CLAUDE.md', 'ROOT');
    const mem = await read(join(base, 'repo'), [join(base, 'repo')]);
    expect(mem?.text).not.toContain('PLANTED-THROUGH-DOT-CLAUDE');
    expect(mem?.notes.map((n) => n.kind)).toContain('file_outside_root');
  });

  it('does not loop on a cycle, and reads a file reached twice once', async () => {
    await put('repo/CLAUDE.md', '@a.md @a.md');
    await put('repo/a.md', 'A-BODY @b.md');
    await put('repo/b.md', 'B-BODY @a.md @CLAUDE.md');
    const mem = await read(join(base, 'repo'), [join(base, 'repo')]);
    expect(mem?.files.map((f) => f.path)).toEqual(['CLAUDE.md', 'a.md', 'b.md']);
  });

  it(`stops following after ${String(WORKSPACE_MEMORY_MAX_IMPORT_DEPTH)} hops, leaves the rest as text and says so`, async () => {
    await put('repo/CLAUDE.md', '@h1.md');
    for (let i = 1; i <= WORKSPACE_MEMORY_MAX_IMPORT_DEPTH + 2; i++) {
      await put(`repo/h${String(i)}.md`, `HOP-${String(i)} @h${String(i + 1)}.md`);
    }
    const mem = await read(join(base, 'repo'), [join(base, 'repo')]);
    // CLAUDE.md is depth 0; h1..h5 are hops 1..5; h6 would be the sixth.
    expect(mem?.files.map((f) => f.path)).toEqual([
      'CLAUDE.md',
      ...Array.from(
        { length: WORKSPACE_MEMORY_MAX_IMPORT_DEPTH },
        (_, i) => `h${String(i + 1)}.md`,
      ),
    ]);
    expect(mem?.notes.map((n) => n.kind)).toEqual(['import_depth_exceeded']);
  });

  it('leaves what is not a file as text without noise: a mention, an e-mail, code', async () => {
    await put('repo/ghost-code.md', 'GHOST');
    await put(
      'repo/CLAUDE.md',
      [
        'Ping @someone about it, mail me at a@ghost-code.md.',
        'Inline `@ghost-code.md` and:',
        '```',
        '@ghost-code.md',
        '```',
        'The end.',
      ].join('\n'),
    );
    const mem = await read(join(base, 'repo'), [join(base, 'repo')]);
    expect(mem?.files.map((f) => f.path)).toEqual(['CLAUDE.md']);
    expect(mem?.text).not.toContain('GHOST');
    expect(mem?.notes).toEqual([]);
    expect(logs).toEqual([]);
  });
});

describe('findImportTokens @cap:travailler-sur-des-fichiers/moteur', () => {
  it('finds @paths outside code and strips trailing punctuation', () => {
    expect(
      findImportTokens('a @x/y.md, b (@z.md). c `@no.md` d@e.f\n```\n@no2.md\n```\n@last.md.'),
    ).toEqual(['x/y.md', 'z.md', 'last.md']);
  });
});

describe('readWorkspaceMemory — the cap is never silent @cap:travailler-sur-des-fichiers/moteur', () => {
  it('under the cap: nothing cut, nothing logged', async () => {
    await put('repo/CLAUDE.md', 'small');
    const mem = await read(join(base, 'repo'), [join(base, 'repo')]);
    expect(mem?.notes).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('over the cap: keeps the files nearest the cwd, cuts the head of the first that does not fit, leaves out the rest, logs every cut', async () => {
    await put('repo/CLAUDE.md', 'FAR-' + 'f'.repeat(900));
    await put('repo/mid/CLAUDE.md', 'MID-' + 'm'.repeat(900));
    await put('repo/mid/near/CLAUDE.md', 'NEAR-' + 'n'.repeat(300));
    const maxBytes = 1000;
    const mem = await read(join(base, 'repo', 'mid', 'near'), [join(base, 'repo')], { maxBytes });

    expect(Buffer.byteLength(mem!.text, 'utf8')).toBeLessThanOrEqual(maxBytes);
    // The nearest is whole; the middle one is cut and marked; the far one is out.
    expect(mem!.text).toContain('NEAR-' + 'n'.repeat(300));
    expect(mem!.text).toMatch(/<file path="mid\/CLAUDE.md" truncated="true" omitted-bytes="\d+">/);
    expect(mem!.text).toContain('MID-');
    expect(mem!.text).not.toContain('FAR-');
    expect(mem!.notes.map((n) => [n.kind, n.path])).toEqual([
      ['truncated_by_cap', 'mid/CLAUDE.md'],
      ['omitted_by_cap', 'CLAUDE.md'],
    ]);
    expect(logs).toHaveLength(2);
    // The omitted-bytes attribute is the truth: cut + kept = the file.
    const omitted = Number(/omitted-bytes="(\d+)"/.exec(mem!.text)![1]);
    const kept = mem!.files.find((f) => f.path === 'mid/CLAUDE.md')!.bytes;
    expect(kept + omitted).toBe(Buffer.byteLength('MID-' + 'm'.repeat(900), 'utf8'));
  });

  it('never splits a multi-byte character when it cuts', async () => {
    await put('repo/CLAUDE.md', 'é'.repeat(2000));
    const mem = await read(join(base, 'repo'), [join(base, 'repo')], { maxBytes: 501 });
    expect(mem!.text).not.toContain('�');
    expect(Buffer.byteLength(mem!.text, 'utf8')).toBeLessThanOrEqual(501);
  });
});
