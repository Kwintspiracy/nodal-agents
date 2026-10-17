// workspace-memory.ts — the project instructions of a workspace, read by Nodal
// and handed to Claude as plain quoted text.
//
// ## Why Nodal reads them
//
// Nodal launches `claude -p` with `--setting-sources user` (claude-setting-
// sources.ts, #782): the folder's own settings can run code on the host, so none
// of them is loaded. Measured on claude 2.1.301, the same switch also drops the
// folder's CLAUDE.md files, so an agent working in a repository stopped hearing
// that repository's rules. Text cannot run anything: Nodal reads the files
// itself and passes them in the system prompt file, which keeps the rules and
// leaves the hole closed.
//
// ## What is read, in which order
//
// From the root of the agent's attached folder that contains the cwd, DOWN to
// the cwd, and in each folder: `CLAUDE.md`, `.claude/CLAUDE.md`,
// `.claude/rules/**/*.md` (sorted), then `CLAUDE.local.md`. The closest folder
// comes last, as Claude itself does. Never above the root: a CLAUDE.md that sits
// outside the agent's folders is not the agent's business, and a confined
// command cannot write there either.
//
// `@path` imports are followed, relative to the file that holds them, only when
// the file's REAL path (after junctions and symlinks) stays inside that same
// root. An import that points outside is left as text, logged, and never read:
// without that, a planted `@../../../somewhere/secret` would carry a file from
// outside the workspace into the prompt. A symlinked CLAUDE.md that resolves
// outside the root is refused the same way.
//
// What is NOT reproduced, and said in the docs: CLAUDE.md files BELOW the cwd,
// which Claude loads on demand when it reads a file there (measured), and the
// user-level ~/.claude one, which `--setting-sources user` still loads itself.
//
// ## The cap
//
// The text has a total size cap. Over it, the files nearest the cwd are kept
// (they are the most specific), the head of the first one that no longer fits is
// cut, the earlier ones are left out, and EVERY cut is logged and reported in
// `notes` and in the wrapper's attributes. Nothing is ever cut silently
// (invariant #4).
//
// ## Wording (invariant #2)
//
// The wrapper carries attributes only: no sentence of Nodal's. The content is
// quoted verbatim, as data.

import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { isWithinRoot } from '@nodal-agents/shared';

/** Total size cap of the text handed to the CLI. Our own limit, not Claude's. */
export const WORKSPACE_MEMORY_MAX_BYTES = 64 * 1024;
/** How many `@import` hops from a CLAUDE.md are followed. Our own limit. */
export const WORKSPACE_MEMORY_MAX_IMPORT_DEPTH = 5;
/** How many `.claude/rules` files one folder may contribute. */
export const WORKSPACE_MEMORY_MAX_RULE_FILES = 100;

export type WorkspaceMemoryNoteKind =
  | 'file_outside_root'
  | 'file_unreadable'
  | 'file_binary'
  | 'import_outside_root'
  | 'import_unreadable'
  | 'import_depth_exceeded'
  | 'too_many_rule_files'
  | 'truncated_by_cap'
  | 'omitted_by_cap';

export interface WorkspaceMemoryNote {
  kind: WorkspaceMemoryNoteKind;
  /** Root-relative path (forward slashes), or the import token as written. */
  path: string;
  detail: string;
}

export interface WorkspaceMemoryFile {
  /** Root-relative path, forward slashes. */
  path: string;
  /** The file that imported this one, when it was reached by `@path`. */
  importedFrom?: string;
  bytes: number;
}

export interface WorkspaceMemory {
  /** The wrapped text, ready for the CLI's system prompt file. */
  text: string;
  /** Files that made it into `text`, in prompt order. */
  files: WorkspaceMemoryFile[];
  notes: WorkspaceMemoryNote[];
}

export interface ReadWorkspaceMemoryInput {
  /** The CLI's working directory. */
  cwd: string;
  /** The agent's attached folders. The one containing the cwd is the upper bound. */
  roots: readonly string[];
  maxBytes?: number;
  /** Where every refusal and cut is logged. Default: console.warn. */
  log?: (message: string) => void;
}

interface Block {
  path: string;
  importedFrom?: string;
  content: string;
}

const fwd = (p: string): string => p.replace(/\\/g, '/');

/** `child` is `root` or inside it, on forward-slash real paths. */
function inside(root: string, child: string): boolean {
  return isWithinRoot(fwd(child), fwd(root));
}

/** Blank out fenced and inline code, keeping offsets, so `@x` in code is not an import. */
function maskCode(text: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, ' ');
  return text.replace(/(^|\n)(```|~~~)[\s\S]*?(\n\2[^\n]*|$)/g, blank).replace(/`[^`\n]*`/g, blank);
}

/** The `@path` tokens of a memory file, in order, as written (trailing punctuation stripped). */
export function findImportTokens(text: string): string[] {
  const masked = maskCode(text);
  const out: string[] = [];
  const re = /(?<![\w@/.\\:-])@([^\s`<>"'()[\]{}]+)/g;
  for (const m of masked.matchAll(re)) {
    const token = m[1]!.replace(/[.,;:!?]+$/, '');
    if (token !== '') out.push(token);
  }
  return out;
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** UTF-8 head of `text` of at most `maxBytes` bytes, never a split character. */
function headBytes(text: string, maxBytes: number): string {
  const cut = Buffer.from(text, 'utf8').subarray(0, Math.max(0, maxBytes)).toString('utf8');
  return cut.endsWith('�') ? cut.slice(0, -1) : cut;
}

function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function openTag(b: Block, extra = ''): string {
  const from = b.importedFrom ? ` imported-from="${attr(b.importedFrom)}"` : '';
  return `<file path="${attr(b.path)}"${from}${extra}>`;
}

const WRAP_OPEN = '<project-instructions source="workspace files, quoted verbatim">';
const WRAP_CLOSE = '</project-instructions>';

/**
 * The workspace's project instructions for the cwd, or null when there is none.
 * Throws when the cwd is not inside any root: the caller resolved it from them,
 * so a miss is a bug to see, not a case to guess a bound for (invariant #4).
 */
export async function readWorkspaceMemory(
  input: ReadWorkspaceMemoryInput,
): Promise<WorkspaceMemory | null> {
  const log = input.log ?? ((m: string) => console.warn(`[workspace-memory] ${m}`));
  const maxBytes = input.maxBytes ?? WORKSPACE_MEMORY_MAX_BYTES;
  const notes: WorkspaceMemoryNote[] = [];
  const note = (n: WorkspaceMemoryNote): void => {
    notes.push(n);
    log(`${n.kind}: ${n.path} — ${n.detail}`);
  };

  const realCwd = await realpath(input.cwd);
  const realRoots: string[] = [];
  for (const r of input.roots) {
    try {
      realRoots.push(await realpath(r));
    } catch (err) {
      if (!isMissing(err)) throw err; // an attached folder that is gone has no memory
    }
  }
  const root = realRoots.filter((r) => inside(r, realCwd)).sort((a, b) => b.length - a.length)[0];
  if (root === undefined) {
    throw new Error(
      `workspace_memory_cwd_outside_roots: "${input.cwd}" is not inside any attached folder ` +
        `(${input.roots.join(', ') || 'none'}); refusing to guess where the instructions stop.`,
    );
  }

  const rel = (abs: string): string => fwd(relative(root, abs)) || '.';
  const seen = new Set<string>();
  const blocks: Block[] = [];

  /** Read one file (and its imports) if it is a regular file whose real path is inside the root. */
  async function load(
    path: string,
    ctx: { depth: number; importedFrom?: string; token?: string },
  ): Promise<void> {
    let real: string;
    try {
      real = await realpath(path);
    } catch (err) {
      if (isMissing(err)) return; // absent is the normal case for most of the candidates
      note({
        kind: ctx.token ? 'import_unreadable' : 'file_unreadable',
        path: ctx.token ?? rel(path),
        detail: (err as Error).message,
      });
      return;
    }
    if (!inside(root!, real)) {
      note({
        kind: ctx.token ? 'import_outside_root' : 'file_outside_root',
        path: ctx.token ?? rel(path),
        detail: `resolves outside the attached folder (${fwd(real)}); not read`,
      });
      return;
    }
    if (seen.has(real)) return; // a cycle, or the same file reached twice
    let buf: Buffer;
    try {
      if (!(await stat(real)).isFile()) return;
      buf = await readFile(real);
    } catch (err) {
      if (isMissing(err)) return;
      note({
        kind: ctx.token ? 'import_unreadable' : 'file_unreadable',
        path: ctx.token ?? rel(path),
        detail: (err as Error).message,
      });
      return;
    }
    if (buf.includes(0)) {
      note({
        kind: 'file_binary',
        path: rel(real),
        detail: 'contains a NUL byte; not a text file, not read',
      });
      return;
    }
    seen.add(real);
    const content = buf.toString('utf8').replace(/^﻿/, '');
    const here = rel(real);
    blocks.push({
      path: here,
      ...(ctx.importedFrom ? { importedFrom: ctx.importedFrom } : {}),
      content,
    });

    for (const token of findImportTokens(content)) {
      // `~/x` means the user's home, as it does for Claude: it is outside the
      // root unless the root is under the home, and the gate below decides.
      const target = /^~[\/]/.test(token)
        ? resolve(homedir(), token.slice(2))
        : resolve(dirname(real), token);
      // Lexical gate FIRST: a target that is outside the root on paper is never
      // even looked at on disk.
      if (!inside(root!, target)) {
        note({
          kind: 'import_outside_root',
          path: token,
          detail: `imported from ${here}; points outside the attached folder, left as text`,
        });
        continue;
      }
      if (ctx.depth >= WORKSPACE_MEMORY_MAX_IMPORT_DEPTH) {
        note({
          kind: 'import_depth_exceeded',
          path: token,
          detail: `imported from ${here}; deeper than ${String(WORKSPACE_MEMORY_MAX_IMPORT_DEPTH)} hops, left as text`,
        });
        continue;
      }
      await load(target, { depth: ctx.depth + 1, importedFrom: here, token });
    }
  }

  async function ruleFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (d: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(d, { withFileTypes: true });
      } catch (err) {
        if (isMissing(err)) return;
        note({ kind: 'file_unreadable', path: rel(d), detail: (err as Error).message });
        return;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const e of entries) {
        const p = join(d, e.name);
        // A real sub-folder is walked; a symlinked one is not (it may lead out).
        if (e.isDirectory()) await walk(p);
        else if (e.name.toLowerCase().endsWith('.md')) out.push(p);
      }
    };
    await walk(join(dir, '.claude', 'rules'));
    if (out.length > WORKSPACE_MEMORY_MAX_RULE_FILES) {
      note({
        kind: 'too_many_rule_files',
        path: rel(join(dir, '.claude', 'rules')),
        detail: `${String(out.length)} files; only the first ${String(WORKSPACE_MEMORY_MAX_RULE_FILES)} are read`,
      });
      return out.slice(0, WORKSPACE_MEMORY_MAX_RULE_FILES);
    }
    return out;
  }

  // The folders from the root down to the cwd, the root first.
  const dirs = [root];
  let at = root;
  for (const segment of fwd(relative(root, realCwd)).split('/').filter(Boolean)) {
    at = join(at, segment);
    dirs.push(at);
  }
  for (const dir of dirs) {
    await load(join(dir, 'CLAUDE.md'), { depth: 0 });
    await load(join(dir, '.claude', 'CLAUDE.md'), { depth: 0 });
    for (const rule of await ruleFiles(dir)) await load(rule, { depth: 0 });
    await load(join(dir, 'CLAUDE.local.md'), { depth: 0 });
  }
  if (blocks.length === 0) return null;

  // The cap: keep what is nearest the cwd, whole while it fits.
  const rendered = (b: Block, extra = '', content = b.content): string =>
    `${openTag(b, extra)}\n${content}\n</file>`;
  const frame = Buffer.byteLength(`${WRAP_OPEN}\n\n${WRAP_CLOSE}`, 'utf8');
  let remaining = maxBytes - frame;
  const kept: string[] = [];
  const files: WorkspaceMemoryFile[] = [];
  let cutAt = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    const whole = rendered(b);
    const size = Buffer.byteLength(whole, 'utf8') + 1; // the joining newline
    if (size <= remaining) {
      kept.unshift(whole);
      files.unshift({
        path: b.path,
        ...(b.importedFrom ? { importedFrom: b.importedFrom } : {}),
        bytes: Buffer.byteLength(b.content, 'utf8'),
      });
      remaining -= size;
      continue;
    }
    // The first block that no longer fits: its head, marked, and the rest is out.
    const total = Buffer.byteLength(b.content, 'utf8');
    const overhead = Buffer.byteLength(
      rendered(b, ` truncated="true" omitted-bytes="${String(total)}"`, ''),
      'utf8',
    );
    const room = remaining - overhead - 1;
    if (room > 0) {
      const head = headBytes(b.content, room);
      const omitted = total - Buffer.byteLength(head, 'utf8');
      kept.unshift(rendered(b, ` truncated="true" omitted-bytes="${String(omitted)}"`, head));
      files.unshift({
        path: b.path,
        ...(b.importedFrom ? { importedFrom: b.importedFrom } : {}),
        bytes: Buffer.byteLength(head, 'utf8'),
      });
      note({
        kind: 'truncated_by_cap',
        path: b.path,
        detail: `${String(omitted)} of ${String(total)} bytes cut to stay under ${String(maxBytes)} bytes`,
      });
      cutAt = i - 1;
    } else {
      cutAt = i;
    }
    break;
  }
  for (let i = cutAt; i >= 0; i--) {
    const b = blocks[i]!;
    note({
      kind: 'omitted_by_cap',
      path: b.path,
      detail: `left out: the ${String(maxBytes)} byte cap is used by files nearer the cwd`,
    });
  }
  if (kept.length === 0) return null; // a cap too small for even one marked head: loud above
  return { text: `${WRAP_OPEN}\n${kept.join('\n')}\n${WRAP_CLOSE}`, files, notes };
}
