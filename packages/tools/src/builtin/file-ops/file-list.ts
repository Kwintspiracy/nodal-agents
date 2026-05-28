// file-ops/file-list.ts — list directory entries with optional glob filter
//
// Multi-workspace behaviour:
//   - No path arg → return the list of workspace labels as top-level virtual entries.
//   - With a path ("notes/a/b") → list inside the resolved workspace (same security
//     guarantees as before).

import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { z } from 'zod';
import type { ToolDefinition } from '../../types';
import {
  resolveAndCheckPath,
  assertWorkspacesConfigured,
  getWorkspaceRootForDisplay,
  WorkspaceError,
} from './workspace';

export const FileListInputSchema = z.object({
  path: z
    .string()
    .optional()
    .describe(
      'Directory path relative to a workspace. For a single-workspace agent, the label prefix ' +
        'is optional (e.g. "subdir/"). For multi-workspace agents, prefix with the workspace ' +
        'label (e.g. "notes/subdir/"). Omit entirely to list workspaces at the top level.',
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
    'List entries of a directory in the agent workspace(s). With no `path` argument, returns ' +
    'the list of available workspace labels. With a path, lists that directory. For ' +
    'multi-workspace agents, prefix paths with the workspace label (e.g. "notes/subdir"). ' +
    'Returns name, type, size, and modified time per entry. Use `glob` to filter (e.g. "*.md"). ' +
    'Pass `recursive:true` to walk subdirectories. Caps at 500 entries.',
  inputSchema: FileListInputSchema,
  riskLevel: 'read',
  execute: async (input, ctx) => {
    try {
      // Guard first (throws if not configured at all)
      const workspaces = assertWorkspacesConfigured(ctx);

      // No path arg → return workspace labels as virtual top-level entries.
      // This lets the LLM discover which workspaces exist before navigating.
      if (input.path === undefined || input.path === null) {
        const entries: FileListEntry[] = workspaces.map((ws) => {
          return {
            name: ws.label,
            type: 'dir' as const,
            size: 0,
            modified: new Date(0).toISOString(),
          };
        });
        return { ok: true, entries, truncated: false };
      }

      const targetPath = await resolveAndCheckPath(ctx, input.path);

      // Use the workspace root that the requested path resolves under for
      // computing relative display paths (the 'name' field in entries).
      const workspaceRoot = getWorkspaceRootForDisplay(ctx, input.path) ?? targetPath;
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
