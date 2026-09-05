// file-ops/file-search.ts — filename + content search across the workspace(s)
//
// Single tool covers both filename and content search via the `target` param.
// Multi-workspace: when no label is given, searches ALL workspaces. When the
// `path` begins with a known workspace label, searches only that workspace.
// Hidden / vendor dirs (.git, node_modules) are skipped by default for perf.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { z } from 'zod';
import type { ToolDefinition } from '../../types';
import { failureText, searchCard } from '../../presenters';
import {
  assertWorkspacesConfigured,
  resolveAndCheckPath,
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
    .describe(
      'Subdirectory to search. For multi-workspace agents, prefix with the workspace label ' +
        '(e.g. "notes/subdir"). Without a label, all workspaces are searched.',
    ),
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
    'Search the agent workspace(s). `target:"files"` matches the regex against file paths. ' +
    '`target:"content"` (default) scans file contents and returns line-level matches. Use ' +
    '`file_glob` to restrict content scans (e.g. "*.md"). For multi-workspace agents, prefix ' +
    '`path` with a workspace label to search only that workspace (e.g. "notes/subdir"), or ' +
    'omit to search all workspaces. Skips .git/node_modules/dist by default.',
  inputSchema: FileSearchInputSchema,
  riskLevel: 'read',
  card: 'search',
  present: ({ input, output }) =>
    output.ok
      ? searchCard({
          query: input.pattern,
          hits: output.matches.map((m) =>
            m.kind === 'content'
              ? { title: m.path, ref: `${m.path}:${m.line}`, snippet: m.snippet }
              : { title: m.path, ref: m.path },
          ),
          truncated: output.truncated,
        })
      : failureText(output.reason),
  execute: async (input, ctx) => {
    try {
      const workspaces = assertWorkspacesConfigured(ctx);

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

      // Determine which workspaces to search and what root path to start from.
      // If `input.path` is given, resolveAndCheckPath selects the right workspace
      // and returns the exact start dir. Otherwise, we walk each workspace root.
      const searchTargets: Array<{ rootForRelative: string; startDir: string }> = [];

      if (input.path !== undefined && input.path !== null && input.path !== '.') {
        // Path provided — let resolver pick the workspace.
        const resolvedStart = await resolveAndCheckPath(ctx, input.path);
        // Find which workspace root this resolved path falls under (for relative display).
        let rootForRelative = workspaces[0]!.path;
        for (const ws of workspaces) {
          const sep = ws.path.endsWith('/') || ws.path.endsWith('\\') ? '' : '/';
          if (resolvedStart === ws.path || resolvedStart.startsWith(ws.path + sep)) {
            rootForRelative = ws.path;
            break;
          }
        }
        searchTargets.push({ rootForRelative, startDir: resolvedStart });
      } else {
        // No path: search all workspaces from their roots.
        for (const ws of workspaces) {
          searchTargets.push({ rootForRelative: ws.path, startDir: ws.path });
        }
      }

      const walk = async (dir: string, workspaceRoot: string): Promise<void> => {
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
            await walk(full, workspaceRoot);
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

      for (const { rootForRelative, startDir } of searchTargets) {
        if (truncated) break;
        await walk(startDir, rootForRelative);
      }

      return { ok: true, matches, truncated };
    } catch (err) {
      if (err instanceof WorkspaceError) return { ok: false, reason: err.message };
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { ok: false, reason: `Directory not found: "${input.path}".` };
      throw err;
    }
  },
};
