// file-ops/file-edit.ts — exact-string-replace edit (Claude-Code-style)
//
// Why exact-string-replace vs unified diff: LLMs are unreliable at producing
// valid diffs (line-number drift, context-line mismatches, indentation slop).
// Exact-string-replace sidesteps the entire problem: the model quotes the
// chunk it wants to change verbatim, we look for a unique match, and swap.
// If the model's quote is wrong by one char, we fail loud — the model sees
// the error and corrects. Empirically far more reliable across model families.

import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { ToolDefinition } from '../../types';
import {
  resolveAndCheckPath,
  computeSharedOverwriteApproval,
  MAX_WRITE_BYTES,
  WorkspaceError,
} from './workspace';

export const FileEditInputSchema = z.object({
  path: z.string().min(1).describe('Path to an existing file, relative to the workspace root.'),
  old_string: z
    .string()
    .min(1)
    .describe(
      'Exact substring to replace. Must appear in the file verbatim — whitespace and line ' +
        'endings count. Must be unique unless replace_all:true.',
    ),
  new_string: z.string().describe('Replacement text. Pass "" to delete the matched substring.'),
  replace_all: z
    .boolean()
    .optional()
    .default(false)
    .describe('Replace every occurrence (default false: require exactly one match).'),
  purpose: z
    .string()
    .optional()
    .describe(
      'OPTIONAL. One short sentence on WHY this edit is needed. Shown first on the approval ' +
        'card when this call requires human review (e.g. editing a file in the shared ' +
        'workspace) — say why in plain language, not what you already say in `path`.',
    ),
});

export type FileEditInput = z.infer<typeof FileEditInputSchema>;
export type FileEditOutput =
  | { ok: true; edited: true; replacements: number; bytes: number }
  | { ok: false; reason: string };

export const fileEditTool: ToolDefinition<typeof FileEditInputSchema, FileEditOutput> = {
  name: 'file_edit',
  description:
    'Edit an existing file by replacing an exact substring. Quote the chunk to change verbatim ' +
    '(including whitespace). Fails loud when the substring is missing (you misquoted) or ' +
    'matches multiple places (ambiguous — narrow the quote, or pass replace_all:true). ' +
    'Use this instead of file_write when you only want to change part of a file — preserves ' +
    'untouched lines.',
  inputSchema: FileEditInputSchema,
  riskLevel: 'write',
  // D1: an edit always targets an EXISTING file (file_edit fails loud on a
  // missing one — see execute() below), so the only thing left to check is
  // whether that file lives in the shared workspace. Same gate as file_write.
  computeApproval: (input, ctx) => computeSharedOverwriteApproval(ctx, input.path),
  execute: async (input, ctx) => {
    try {
      const path = await resolveAndCheckPath(ctx, input.path);
      const original = await readFile(path, 'utf8');
      if (!original.includes(input.old_string)) {
        return {
          ok: false,
          reason: `old_string not found in "${input.path}". Re-read the file and quote the exact substring (whitespace counts).`,
        };
      }
      let replacements = 0;
      let updated: string;
      if (input.replace_all) {
        updated = original.split(input.old_string).join(input.new_string);
        replacements =
          original.length - updated.length + input.new_string.length * 0 === 0
            ? original.split(input.old_string).length - 1
            : original.split(input.old_string).length - 1;
      } else {
        const firstIdx = original.indexOf(input.old_string);
        const secondIdx = original.indexOf(input.old_string, firstIdx + 1);
        if (secondIdx !== -1) {
          return {
            ok: false,
            reason: `old_string matches multiple places in "${input.path}". Narrow the quote (add surrounding context) or pass replace_all:true.`,
          };
        }
        updated =
          original.slice(0, firstIdx) +
          input.new_string +
          original.slice(firstIdx + input.old_string.length);
        replacements = 1;
      }
      const bytes = Buffer.byteLength(updated, 'utf8');
      if (bytes > MAX_WRITE_BYTES) {
        return {
          ok: false,
          reason: `Edit would produce ${bytes} bytes (max ${MAX_WRITE_BYTES}). Split the change.`,
        };
      }
      // Atomic write
      const dir = dirname(path);
      const tmp = `${dir}/.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await writeFile(tmp, updated, 'utf8');
        await rename(tmp, path);
      } catch (err) {
        await unlink(tmp).catch(() => undefined);
        throw err;
      }
      return { ok: true, edited: true, replacements, bytes };
    } catch (err) {
      if (err instanceof WorkspaceError) return { ok: false, reason: err.message };
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return {
          ok: false,
          reason: `File not found: "${input.path}". Use file_write to create new files.`,
        };
      }
      throw err;
    }
  },
};
