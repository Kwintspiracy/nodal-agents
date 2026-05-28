// file-ops/file-list.ts — list directory entries with optional glob filter

import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { z } from 'zod';
import type { ToolDefinition } from '../../types';
import { resolveAndCheckPath, assertWorkspaceConfigured, WorkspaceError } from './workspace';

export const FileListInputSchema = z.object({
  path: z
    .string()
    .optional()
    .describe(
      'Directory path relative to workspace root. Default "." (the workspace root itself).',
    ),
  glob: z
    .string()
    .optional()
    .describe(
      'Optional glob to filter results (e.g. "*.md", "**/*.ts"). Matched against the name ' +
        'for non-recursive, against the relative path for recursive (** prefix).',
    ),
  recursive: z.boolean().optional().default(false).describe('Walk subdirectories. Default false.'),
});

export type FileListInput = z.infer<typeof FileListInputSchema>;
export type FileListEntry = { name: string; type: 'file' | 'dir'; size: number; modified: string };
export type FileListOutput =
  | { ok: true; entries: FileListEntry[]; truncated: boolean }
  | { ok: false; reason: string };

const MAX_ENTRIES = 500;

/** Minimal glob matcher.
 *  - `** /` (without space) matches zero or more directory segments, so
 *    `** /*.md` matches `top.md` AND `sub/nested.md`.
 *  - `**` (bare) matches anything including `/`.
 *  - `*` matches a single segment (no `/`).
 *  - `?` matches one non-separator char.
 */
function globToRegex(glob: string): RegExp {
  // Two-phase: placeholder glob-special tokens FIRST so they survive the
  // subsequent regex-special escape pass without colliding with the
  // expansion's own quantifiers (`(?:...)*` would otherwise be eaten by a
  // later `**` pass).
  const DOUBLE_STAR_SLASH = '\x00';
  const DOUBLE_STAR = '\x01';
  const SINGLE_STAR = '\x02';
  const QUESTION = '\x03';
  const result = glob
    .replace(/\*\*\//g, DOUBLE_STAR_SLASH)
    .replace(/\*\*/g, DOUBLE_STAR)
    .replace(/\*/g, SINGLE_STAR)
    .replace(/\?/g, QUESTION)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(new RegExp(DOUBLE_STAR_SLASH, 'g'), '(?:[^/\\\\]+[/\\\\])*')
    .replace(new RegExp(DOUBLE_STAR, 'g'), '.*')
    .replace(new RegExp(SINGLE_STAR, 'g'), '[^/\\\\]*')
    .replace(new RegExp(QUESTION, 'g'), '[^/\\\\]');
  return new RegExp(`^${result}$`);
}

export const fileListTool: ToolDefinition<typeof FileListInputSchema, FileListOutput> = {
  name: 'file_list',
  description:
    'List entries of a directory in the agent workspace. Returns name, type, size, and modified ' +
    'time per entry. Use `glob` to filter (e.g. "*.md"). Pass `recursive:true` to walk ' +
    'subdirectories. Caps at 500 entries — narrow the glob if you hit the cap.',
  inputSchema: FileListInputSchema,
  riskLevel: 'read',
  execute: async (input, ctx) => {
    try {
      const targetPath = await resolveAndCheckPath(ctx, input.path ?? '.');
      const workspaceRoot = assertWorkspaceConfigured(ctx);
      const matcher = input.glob ? globToRegex(input.glob) : null;
      const entries: FileListEntry[] = [];
      let truncated = false;

      const walk = async (dir: string): Promise<void> => {
        const dirents = await readdir(dir, { withFileTypes: true });
        for (const dirent of dirents) {
          if (entries.length >= MAX_ENTRIES) {
            truncated = true;
            return;
          }
          const full = join(dir, dirent.name);
          const rel = relative(workspaceRoot, full).replace(/\\/g, '/');
          const isDir = dirent.isDirectory();
          if (matcher) {
            const candidate = input.recursive ? rel : dirent.name;
            if (!matcher.test(candidate)) {
              if (input.recursive && isDir) await walk(full);
              continue;
            }
          }
          const info = await stat(full);
          entries.push({
            name: input.recursive ? rel : dirent.name,
            type: isDir ? 'dir' : 'file',
            size: info.size,
            modified: info.mtime.toISOString(),
          });
          if (input.recursive && isDir) await walk(full);
        }
      };

      await walk(targetPath);
      return { ok: true, entries, truncated };
    } catch (err) {
      if (err instanceof WorkspaceError) return { ok: false, reason: err.message };
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { ok: false, reason: `Directory not found: "${input.path}".` };
      if (code === 'ENOTDIR') return { ok: false, reason: `Not a directory: "${input.path}".` };
      throw err;
    }
  },
};
