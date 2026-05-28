// file-ops/file-read.ts — read a workspace-scoped file with line pagination

import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import type { ToolDefinition } from '../../types';
import { resolveAndCheckPath, MAX_READ_BYTES, WorkspaceError } from './workspace';

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
    'MUST be paginated — request smaller chunks. Use `file_search` first if you need to find ' +
    'specific content.',
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
      if (info.size > MAX_READ_BYTES) {
        const offset = input.offset ?? 1;
        const limit = input.limit ?? 500;
        // Streaming-by-line for huge files: read whole file (still capped by
        // MAX_READ_BYTES check above — wait, no, that's the file size). We
        // need to handle >1MB files. Read the whole thing for now and rely on
        // line slicing. If perf becomes a problem, switch to a streaming
        // reader. The LLM should paginate via offset/limit either way.
        // For files much larger than MAX_READ_BYTES, force pagination by
        // refusing the call without offset/limit:
        if (input.offset === undefined && input.limit === undefined) {
          return {
            ok: false,
            reason: `File is ${info.size} bytes (> ${MAX_READ_BYTES}). Call again with explicit offset and limit.`,
          };
        }
        // Pagination provided — proceed but warn caller of partial read
        const raw = await readFile(path, 'utf8');
        const allLines = raw.split('\n');
        const startIdx = Math.max(0, offset - 1);
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
      }
      const raw = await readFile(path, 'utf8');
      const allLines = raw.split('\n');
      const offset = input.offset ?? 1;
      const limit = input.limit ?? 500;
      const startIdx = Math.max(0, offset - 1);
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
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ok: false, reason: `File not found: "${input.path}".` };
      }
      throw err;
    }
  },
};
