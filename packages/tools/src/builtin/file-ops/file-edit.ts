// file-ops/file-edit.ts — exact-string-replace edit (Claude-Code-style)
//
// Why exact-string-replace vs unified diff: LLMs are unreliable at producing
// valid diffs (line-number drift, context-line mismatches, indentation slop).
// Exact-string-replace sidesteps the entire problem: the model quotes the
// chunk it wants to change verbatim, we look for a unique match, and swap.
// If the model's quote is wrong by one char, we fail loud — the model sees
// the error and corrects. Empirically far more reliable across model families.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { writeFileAtomically } from './atomic-write';
import { changedSinceSeen, decodeText, notTextReason } from './text-file';
import { spliceEdit } from './text-edit';
import { refusePlaceholderWrite, refuseQuotedPlaceholder } from './mask-guard';
import { z } from 'zod';
import type { ToolDefinition } from '../../types';
import { detailOf, failureText, writtenFile } from '../../presenters';
import {
  declaredWrittenFileType,
  deliverableTypeForWrittenFile,
} from '../../verification/written-file-type';
import { fileDeliverableKey } from '../../verification/office-file-key';
import {
  resolveAndCheckPath,
  computeSharedOverwriteApproval,
  isProtectedWorkflowTemplate,
  WORKFLOW_TEMPLATE_PROTECTED_MESSAGE,
  MAX_WRITE_BYTES,
  WorkspaceError,
} from './workspace';
import { outcomeOfOkFlag } from '../../outcome';

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
  encoding: z
    .string()
    .optional()
    .describe(
      'Only when a call said the encoding could not be determined: the encoding of the file ' +
        '(e.g. "windows-1252", "shift_jis"). Otherwise it is detected.',
    ),
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
  | {
      ok: true;
      edited: true;
      replacements: number;
      bytes: number;
      /** La clé du DOCUMENT édité, quand c'en est un — voir `file-write.ts`. */
      deliverable_key?: string;
    }
  | { ok: false; reason: string };

export const fileEditTool: ToolDefinition<typeof FileEditInputSchema, FileEditOutput> = {
  name: 'file_edit',
  label: 'Edit a workspace file',
  summary:
    'Replace an exact part of a file while leaving the rest untouched. The edit fails if the target text is missing or ambiguous.',
  description:
    'Edit an existing file by replacing an exact substring. Quote the chunk to change verbatim ' +
    '(including whitespace; a CRLF file may be quoted with LF line endings). Fails loud ' +
    'when the substring is missing (you misquoted) or matches multiple places (ambiguous — ' +
    'narrow the quote, or pass replace_all:true). Use this instead of file_write when you only ' +
    'want to change part of a file: every byte outside the replaced text stays as it was, and ' +
    'the file keeps its encoding, byte-order mark and line endings. Refused when the file ' +
    'changed since this job last read it, or is not text.',
  inputSchema: FileEditInputSchema,
  riskLevel: 'write',
  egress: 'none',
  loading: 'eager',
  card: 'files',
  present: ({ input, output }) =>
    output.ok
      ? writtenFile(input.path, 'modified', {
          bytes: output.bytes,
          detail: detailOf(output, ['edited', 'bytes', 'deliverable_key']),
          ...(output.deliverable_key !== undefined
            ? { deliverableKey: output.deliverable_key }
            : {}),
        })
      : failureText(output.reason),
  mutatesWorkspace: true,
  // The ONE file this edit is about to change — same contract, same reasons
  // as file_write's hook (declared target, resolved twice, empty on a
  // resolution failure that execute() will report properly).
  //
  // Et, comme lui, la `catch` ne couvre QUE la résolution : un classement qui
  // lève remonte au seam plutôt que de se déguiser en « aucune cible »
  // (issue #211, voir le commentaire de `file-write.ts`).
  resolveMutationTargets: async (input, ctx) => {
    let path: string;
    try {
      path = await resolveAndCheckPath(ctx, input.path);
    } catch {
      return [];
    }
    // Même règle que file_write : code sous un projet de code, document
    // sinon (`written-file-type.ts`). Aucune reconnaissance d'extension.
    return [
      { kind: 'file', path, deliverableType: await deliverableTypeForWrittenFile(ctx, path) },
    ];
  },
  // D1: an edit always targets an EXISTING file (file_edit fails loud on a
  // missing one — see execute() below), so the only thing left to check is
  // whether that file lives in the shared workspace. Same gate as file_write.
  // P4: a protected workflow template is refused outright at execute() —
  // never surface an approval prompt for a call that can never succeed.
  replacesSharedFile: async (input, ctx) => {
    try {
      const path = await resolveAndCheckPath(ctx, input.path);
      if (await isProtectedWorkflowTemplate(ctx, path)) return false;
    } catch {
      return false; // resolution failure — execute() will fail loud on it
    }
    return (await computeSharedOverwriteApproval(ctx, input.path)) === 'require_approval';
  },
  outcomeOf: outcomeOfOkFlag,
  execute: async (input, ctx) => {
    try {
      const path = await resolveAndCheckPath(ctx, input.path);
      // P4 — shared canonical workflow templates are read-only to this tool.
      // See isProtectedWorkflowTemplate (workspace.ts) for the rationale.
      if (await isProtectedWorkflowTemplate(ctx, path)) {
        return { ok: false, reason: WORKFLOW_TEMPLATE_PROTECTED_MESSAGE };
      }
      const lu = await readFile(path);
      const sha256 = createHash('sha256').update(lu).digest('hex');
      // Les octets LUS, rapportés au seam (tool_call_reads).
      ctx.reportReadContent?.(path, sha256);
      const stale = await changedSinceSeen(ctx, path, sha256, input.path, 'part');
      if (stale !== null) return { ok: false, reason: stale };
      // La couche texte : le fichier comme texte, et la forme dans laquelle il
      // est écrit — ou le refus, et pourquoi (`text-file.ts`).
      const decoded = decodeText(lu, input.encoding);
      if (!decoded.ok) {
        return {
          ok: false,
          reason: await notTextReason(input.path, lu, decoded, 'Nothing was written.'),
        };
      }
      // A masked read is never written back (mask-guard.ts): a quote of a line
      // the agent saw masked, or a replacement that adds the mark, is refused
      // with the hidden lines named, before the quoted text is searched for.
      const placeholder =
        (await refuseQuotedPlaceholder(ctx, {
          path,
          shownPath: input.path,
          quoted: input.old_string,
          current: decoded.text,
        })) ??
        (await refusePlaceholderWrite(ctx, {
          path,
          shownPath: input.path,
          before: input.old_string,
          after: input.new_string,
          current: decoded.text,
        }));
      if (placeholder !== null) return { ok: false, reason: placeholder };
      const spliced = spliceEdit(lu, decoded.text, decoded.form, input);
      if (!spliced.ok) {
        if (spliced.why === 'unrepresentable') {
          return {
            ok: false,
            reason:
              `"${input.path}" is written in ${decoded.form.encoding}, and ${spliced.detail}. ` +
              'Nothing was written. Use characters it has, or convert the whole file with ' +
              'file_write and "encoding": "utf-8".',
          };
        }
        return {
          ok: false,
          reason:
            spliced.why === 'not_found'
              ? `old_string not found in "${input.path}". Re-read the file and quote the exact substring (whitespace counts).`
              : `old_string matches multiple places in "${input.path}". Narrow the quote (add surrounding context) or pass replace_all:true.`,
        };
      }
      const { bytes: updated, replacements } = spliced;
      const bytes = updated.length;
      if (bytes > MAX_WRITE_BYTES) {
        return {
          ok: false,
          reason: `Edit would produce ${bytes} bytes (max ${MAX_WRITE_BYTES}). Split the change.`,
        };
      }
      // Même règle que `file_write` : le type n'est PAS reclassé ici, c'est la
      // décision du hook, relue telle quelle. Elle était refaite, et l'écart
      // entre les deux réponses rendait l'état introuvable — que l'écart
      // vienne du disque (le premier `package.json` d'un dossier, revue Codex
      // post-merge de la PR #66, constat C3) ou de la table `code_projects`,
      // qui peut changer entre le hook et ici (revue C, dette #88).
      const deliverableType =
        declaredWrittenFileType(ctx, path) ?? (await deliverableTypeForWrittenFile(ctx, path));
      const deliverableKey =
        deliverableType === 'document'
          ? fileDeliverableKey(
              path,
              (ctx.workspaces ?? []).map((w) => w.path),
              'document',
            )
          : null;
      // Atomic write, last ownership check and written-content fingerprint (#505).
      await writeFileAtomically(ctx, path, updated);
      return {
        ok: true,
        edited: true,
        replacements,
        bytes,
        ...(deliverableKey !== null ? { deliverable_key: deliverableKey } : {}),
      };
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
