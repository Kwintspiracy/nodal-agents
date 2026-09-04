// file-ops/file-write.ts — atomic write (tempfile + rename) within workspace

import { writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { dirname, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { ToolDefinition } from '../../types';
import {
  resolveAndCheckPath,
  computeSharedOverwriteApproval,
  isProtectedWorkflowTemplate,
  WORKFLOW_TEMPLATE_PROTECTED_MESSAGE,
  MAX_WRITE_BYTES,
  WorkspaceError,
} from './workspace';

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
  purpose: z
    .string()
    .optional()
    .describe(
      'OPTIONAL. One short sentence on WHY this write is needed. Shown first on the ' +
        'approval card when this call requires human review (e.g. overwriting an existing ' +
        'file in the shared workspace) — say why in plain language, not what you already say ' +
        'in `path`/`content`.',
    ),
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
  mutatesWorkspace: true,
  // The ONE file this call is about to write — the same resolution execute()
  // does below, run again here rather than guessed at the seam. Resolving
  // twice is already the accepted pattern in this file (computeApproval does
  // it too): the cost is a path join, and the alternative is a verification
  // layer that has to re-implement every tool's addressing.
  //
  // A resolution failure yields NO target, exactly like computeApproval's
  // catch: no write will leave this call anyway — execute() fails loud on the
  // same error a few lines down, with the message the agent can act on.
  resolveMutationTargets: async (input, ctx) => {
    try {
      return [{ kind: 'file', path: await resolveAndCheckPath(ctx, input.path) }];
    } catch {
      return [];
    }
  },
  // D1: gate ONLY the destructive case — overwriting a file that already
  // exists in the entity-wide SHARED workspace. A brand-new file, or a write
  // into an attached/private workspace, never gates (see computeSharedOverwriteApproval).
  // P4: a protected workflow template is refused outright at execute() —
  // never surface an approval prompt for a call that can never succeed.
  computeApproval: async (input, ctx) => {
    try {
      const path = await resolveAndCheckPath(ctx, input.path);
      if (await isProtectedWorkflowTemplate(ctx, path)) return undefined;
    } catch {
      return undefined; // resolution failure — execute() will fail loud on it
    }
    return computeSharedOverwriteApproval(ctx, input.path);
  },
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
      // P4 — shared canonical workflow templates are read-only to this tool.
      // See isProtectedWorkflowTemplate (workspace.ts) for the rationale.
      if (await isProtectedWorkflowTemplate(ctx, path)) {
        return { ok: false, reason: WORKFLOW_TEMPLATE_PROTECTED_MESSAGE };
      }
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
