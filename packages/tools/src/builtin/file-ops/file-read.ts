// file-ops/file-read.ts — read a workspace-scoped file with line pagination

import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import type { ToolDefinition } from '../../types';
import { resolveAndCheckPath, MAX_READ_BYTES, MAX_READ_FILE_BYTES, WorkspaceError } from './workspace';
import { readLinesWindowed, ReadLinesCapExceededError } from './read-lines';

export const FileReadInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      'Path to the file, relative to the agent workspace root. Absolute paths are accepted ' +
        'but must resolve under the workspace.',
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('1-based line number to start at. Default 1.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(2000)
    .optional()
    .describe('Max number of lines to return. Default 500.'),
});

export type FileReadInput = z.infer<typeof FileReadInputSchema>;
export type FileReadOutput =
  | {
      ok: true;
      content: string;
      total_lines: number;
      start_line: number;
      end_line: number;
      truncated: boolean;
    }
  | { ok: false; reason: string };

export const fileReadTool: ToolDefinition<typeof FileReadInputSchema, FileReadOutput> = {
  name: 'file_read',
  description:
    'Read the contents of a file in the agent workspace. Returns lines with start_line / ' +
    'end_line markers. Use `offset` and `limit` to paginate large files. Files above ~1 MiB ' +
    'MUST be paginated — request smaller chunks. Files above 50 MiB are refused outright, ' +
    'even with offset/limit — use `file_search` to locate content, or split the file.',
  inputSchema: FileReadInputSchema,
  riskLevel: 'read',
  execute: async (input, ctx) => {
    try {
      const path = await resolveAndCheckPath(ctx, input.path);
      const info = await stat(path);
      if (info.isDirectory()) {
        return {
          ok: false,
          reason: `Path is a directory, not a file: "${input.path}". Use file_list.`,
        };
      }

      // Absolute hard cap: refused no matter what, even with offset/limit —
      // there is no safe way to serve any window without scanning the whole
      // file once, and above this size that scan itself is the OOM risk.
      if (info.size > MAX_READ_FILE_BYTES) {
        return {
          ok: false,
          reason:
            `File is ${info.size} bytes, exceeding the hard read cap of ${MAX_READ_FILE_BYTES} ` +
            `bytes (50 MiB) — refusing to read it at all, even with offset/limit. Use ` +
            `file_search to locate the content you need, or split the file into smaller pieces.`,
        };
      }

      const offset = input.offset ?? 1;
      const limit = input.limit ?? 500;
      const startIdx = Math.max(0, offset - 1);

      if (info.size > MAX_READ_BYTES) {
        if (input.offset === undefined && input.limit === undefined) {
          return {
            ok: false,
            reason: `File is ${info.size} bytes (> ${MAX_READ_BYTES}). Call again with explicit offset and limit.`,
          };
        }
        // Bounded-memory streaming read for files between MAX_READ_BYTES and
        // MAX_READ_FILE_BYTES — never loads the whole file into a string.
        // maxBytes is a TOCTOU defense: the file could grow past the stat()
        // check above between here and stream completion (concurrent writer
        // on a shared workspace) — readLinesWindowed aborts if that happens.
        const { windowLines, totalLines } = await readLinesWindowed(
          path,
          startIdx,
          startIdx + limit,
          undefined,
          MAX_READ_FILE_BYTES,
        );
        const endIdx = Math.min(totalLines, startIdx + limit);
        return {
          ok: true,
          content: windowLines.join('\n'),
          total_lines: totalLines,
          start_line: startIdx + 1,
          end_line: endIdx,
          truncated: endIdx < totalLines,
        };
      }

      const raw = await readFile(path, 'utf8');
      const allLines = raw.split('\n');
      const endIdx = Math.min(allLines.length, startIdx + limit);
      const selectedContent = allLines.slice(startIdx, endIdx).join('\n');
      return {
        ok: true,
        content: selectedContent,
        total_lines: allLines.length,
        start_line: startIdx + 1,
        end_line: endIdx,
        truncated: endIdx < allLines.length,
      };
    } catch (err) {
      if (err instanceof WorkspaceError) return { ok: false, reason: err.message };
      if (err instanceof ReadLinesCapExceededError) return { ok: false, reason: err.message };
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ok: false, reason: `File not found: "${input.path}".` };
      }
      throw err;
    }
  },
};
