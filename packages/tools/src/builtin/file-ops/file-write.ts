// file-ops/file-write.ts — atomic write (tempfile + rename) within workspace

import { writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { dirname, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { ToolDefinition } from '../../types';
import { resolveAndCheckPath, MAX_WRITE_BYTES, WorkspaceError } from './workspace';

export const FileWriteInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe('Path to the file, relative to the agent workspace root. Created if missing.'),
  content: z.string().describe('Full file contents to write. Overwrites any existing file.'),
  create_dirs: z
    .boolean()
    .optional()
    .default(false)
    .describe('If true, create missing parent directories.'),
});

export type FileWriteInput = z.infer<typeof FileWriteInputSchema>;
export type FileWriteOutput =
  | { ok: true; written: true; bytes: number; path: string }
  | { ok: false; reason: string };

export const fileWriteTool: ToolDefinition<typeof FileWriteInputSchema, FileWriteOutput> = {
  name: 'file_write',
  description:
    'Write (or overwrite) a file in the agent workspace. Atomic: writes to a tempfile then ' +
    'renames over the target, so partial-write failures never corrupt the original. Use ' +
    '`file_edit` instead when you only need to change part of an existing file — it preserves ' +
    'lines you do not touch. Max 1 MiB per write.',
  inputSchema: FileWriteInputSchema,
  riskLevel: 'write',
  execute: async (input, ctx) => {
    try {
      const bytes = Buffer.byteLength(input.content, 'utf8');
      if (bytes > MAX_WRITE_BYTES) {
        return {
          ok: false,
          reason: `Refusing to write ${bytes} bytes (max ${MAX_WRITE_BYTES}). Split the content.`,
        };
      }
      const path = await resolveAndCheckPath(ctx, input.path);
      const dir = dirname(path);
      if (input.create_dirs) {
        await mkdir(dir, { recursive: true });
      }
      // Atomic write: tempfile in same dir (same filesystem → rename is atomic)
      const tmp = `${dir}/.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await writeFile(tmp, input.content, 'utf8');
        await rename(tmp, path);
      } catch (err) {
        // Best-effort cleanup of tempfile if rename failed
        await unlink(tmp).catch(() => undefined);
        throw err;
      }
      return { ok: true, written: true, bytes, path };
    } catch (err) {
      if (err instanceof WorkspaceError) return { ok: false, reason: err.message };
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return {
          ok: false,
          reason: `Parent directory does not exist for "${input.path}". Pass create_dirs:true to create it.`,
        };
      }
      throw err;
    }
  },
};
