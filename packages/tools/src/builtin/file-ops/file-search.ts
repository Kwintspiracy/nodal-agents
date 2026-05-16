// file-ops/file-search.ts — filename + content search across the workspace
//
// Single tool covers both filename and content search via the `target` param.
// Implementation walks the workspace (cheap on local FS), filters by file_glob,
// and either matches the pattern against the path or scans the file contents.
// Hidden / vendor dirs (.git, node_modules) are skipped by default for perf.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { z } from 'zod';
import type { ToolDefinition } from '../../types';
import {
  resolveAndCheckPath,
  assertWorkspaceConfigured,
  MAX_SEARCH_FILE_BYTES,
  WorkspaceError,
} from './workspace';

export const FileSearchInputSchema = z.object({
  pattern: z.string().min(1).describe('Regex pattern to search for.'),
  target: z
    .enum(['files', 'content'])
    .optional()
    .default('content')
    .describe(
      '"files" matches the pattern against file paths (filename search). "content" scans ' +
        'each file body (grep-like). Default "content".',
    ),
  path: z
    .string()
    .optional()
    .describe('Subdirectory (under workspace root) to search. Default "." (full workspace).'),
  file_glob: z
    .string()
    .optional()
    .describe('Restrict content search to files matching this glob (e.g. "*.md").'),
  case_sensitive: z
    .boolean()
    .optional()
    .default(false)
    .describe('Default false — pattern is matched case-insensitively.'),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .default(100)
    .describe('Cap on matches returned. Narrow `path` or `file_glob` if you hit it.'),
});

export type FileSearchInput = z.infer<typeof FileSearchInputSchema>;
export type FileSearchMatch =
  | { kind: 'file'; path: string }
  | { kind: 'content'; path: string; line: number; snippet: string };
export type FileSearchOutput =
  | { ok: true; matches: FileSearchMatch[]; truncated: boolean }
  | { ok: false; reason: string };

const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', '.turbo', '.cache']);

function globToRegex(glob: string): RegExp {
  // See file-list.ts for the rationale of the sentinel-first two-phase scheme.
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

export const fileSearchTool: ToolDefinition<typeof FileSearchInputSchema, FileSearchOutput> = {
  name: 'file_search',
  description:
    'Search the agent workspace. `target:"files"` matches the regex against file paths. ' +
    '`target:"content"` (default) scans file contents and returns line-level matches. Use ' +
    '`file_glob` to restrict content scans (e.g. "*.md"). Skips .git/node_modules/dist by default.',
  inputSchema: FileSearchInputSchema,
  riskLevel: 'read',
  execute: async (input, ctx) => {
    try {
      const targetPath = await resolveAndCheckPath(ctx, input.path ?? '.');
      const workspaceRoot = assertWorkspaceConfigured(ctx);
      const flags = input.case_sensitive ? '' : 'i';
      let patternRe: RegExp;
      try {
        patternRe = new RegExp(input.pattern, flags);
      } catch (err) {
        return { ok: false, reason: `Invalid regex pattern: ${(err as Error).message}` };
      }
      const globRe = input.file_glob ? globToRegex(input.file_glob) : null;
      const matches: FileSearchMatch[] = [];
      let truncated = false;

      const walk = async (dir: string): Promise<void> => {
        if (matches.length >= input.max_results) {
          truncated = true;
          return;
        }
        const dirents = await readdir(dir, { withFileTypes: true });
        for (const dirent of dirents) {
          if (matches.length >= input.max_results) {
            truncated = true;
            return;
          }
          const full = join(dir, dirent.name);
          const rel = relative(workspaceRoot, full).replace(/\\/g, '/');
          if (dirent.isDirectory()) {
            if (SKIP_DIRS.has(dirent.name)) continue;
            await walk(full);
            continue;
          }
          if (!dirent.isFile()) continue;

          if (input.target === 'files') {
            if (patternRe.test(rel) || patternRe.test(dirent.name)) {
              matches.push({ kind: 'file', path: rel });
            }
            continue;
          }

          // content search
          if (globRe && !globRe.test(dirent.name) && !globRe.test(rel)) continue;
          const info = await stat(full);
          if (info.size > MAX_SEARCH_FILE_BYTES) continue;
          let body: string;
          try {
            body = await readFile(full, 'utf8');
          } catch {
            continue; // binary or unreadable — skip
          }
          const lines = body.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (matches.length >= input.max_results) {
              truncated = true;
              return;
            }
            const line = lines[i] ?? '';
            if (patternRe.test(line)) {
              matches.push({
                kind: 'content',
                path: rel,
                line: i + 1,
                snippet: line.slice(0, 240),
              });
            }
          }
        }
      };

      await walk(targetPath);
      return { ok: true, matches, truncated };
    } catch (err) {
      if (err instanceof WorkspaceError) return { ok: false, reason: err.message };
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { ok: false, reason: `Directory not found: "${input.path}".` };
      throw err;
    }
  },
};
