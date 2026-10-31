// file-ops/file-read.ts — read a workspace-scoped file with line pagination

import { createHash } from 'node:crypto';
import { open, readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import type { ToolContext, ToolDefinition } from '../../types';
import { failureText, readCard } from '../../presenters';
import {
  resolveAndCheckPath,
  MAX_READ_BYTES,
  MAX_READ_FILE_BYTES,
  WorkspaceError,
} from './workspace';
import { readLinesWindowed, ReadLinesCapExceededError } from './read-lines';
import { MODEL_REQUEST_MAX_IMAGES } from '@nodal-agents/shared';
import {
  MAX_MODEL_IMAGE_BYTES,
  MAX_MODEL_PDF_BYTES,
  PDF_MEDIA_TYPE,
  countPdfPages,
  formatBytes,
  sniffAttachmentMediaType,
} from '../../model-images';

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
  /**
   * An image file, handed to the model with this result (`ctx.attachForModel`):
   * the row keeps its type and size, never its bytes.
   */
  | { ok: true; image: { media_type: string; bytes: number } }
  /** A PDF document, handed the same way: its type, size and pages, never its bytes. */
  | { ok: true; document: { media_type: string; bytes: number; pages: number } }
  | { ok: false; reason: string };

/** The first bytes of a file, enough for `sniffAttachmentMediaType`. */
const SNIFF_BYTES = 16;

async function readHead(path: string): Promise<Uint8Array> {
  const handle = await open(path, 'r');
  try {
    const buf = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buf, 0, SNIFF_BYTES, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** What a file the model reads whole is, said in every answer about it. */
function describe(path: string, mediaType: string, bytes: number, pages?: number): string {
  if (mediaType !== PDF_MEDIA_TYPE)
    return `"${path}" is an image (${mediaType}, ${formatBytes(bytes)})`;
  const counted = pages === undefined ? '' : `${pages} page(s), `;
  return `"${path}" is a PDF document (${counted}${formatBytes(bytes)})`;
}

/**
 * A file the model reads whole — an image, a PDF: attached for the model when
 * it takes that kind of file, and refused, saying why, when it does not. Never
 * its bytes as text. A PDF's pages are counted first: the request budget
 * spends them, and a file that only starts like a PDF is refused here.
 */
async function attachmentResult(
  input: FileReadInput,
  absPath: string,
  bytes: Buffer,
  mediaType: string,
  ctx: ToolContext,
): Promise<FileReadOutput> {
  let pages: number | undefined;
  if (mediaType === PDF_MEDIA_TYPE) {
    const counted = await countPdfPages(bytes);
    if ('error' in counted) {
      return {
        ok: false,
        reason:
          `${describe(input.path, mediaType, bytes.length)}, and it was not read: it could not be ` +
          `opened as a PDF (${counted.error}).`,
      };
    }
    pages = counted.pages;
  }
  const what = describe(input.path, mediaType, bytes.length, pages);
  const outcome = ctx.attachForModel?.({
    mediaType,
    data: bytes.toString('base64'),
    ...(pages === undefined ? {} : { pages }),
  }) ?? {
    attached: false as const,
    reason: `this run does not pass ${pages === undefined ? 'images' : 'PDF documents'} to a model`,
  };
  if (!outcome.attached) {
    return { ok: false, reason: `${what}, and it was not read: ${outcome.reason}.` };
  }
  // Les octets LUS, rapportés au seam (tool_call_reads), comme pour un texte.
  ctx.reportReadContent?.(absPath, createHash('sha256').update(bytes).digest('hex'));
  return pages === undefined
    ? { ok: true, image: { media_type: mediaType, bytes: bytes.length } }
    : { ok: true, document: { media_type: mediaType, bytes: bytes.length, pages } };
}

export const fileReadTool: ToolDefinition<typeof FileReadInputSchema, FileReadOutput> = {
  name: 'file_read',
  label: 'Read a workspace file',
  summary:
    'Read file contents, a section at a time for large files. Files over 50 MiB cannot be read with this tool.',
  description:
    'Read the contents of a file in the agent workspace. Returns lines with start_line / ' +
    'end_line markers. Use `offset` and `limit` to paginate large files. Files above ~1 MiB ' +
    'MUST be paginated — request smaller chunks. Files above 50 MiB are refused outright, ' +
    'even with offset/limit — use `file_search` to locate content, or split the file. ' +
    'An image file (PNG, JPEG, GIF, WebP, up to 1 MiB) is returned as the image itself when ' +
    `your model takes images as input, and a PDF (up to ${formatBytes(MAX_MODEL_PDF_BYTES)} and ` +
    `${MODEL_REQUEST_MAX_IMAGES} pages) as the document itself, scanned pages included, when ` +
    'your model takes PDFs; otherwise the call says why it was not read.',
  inputSchema: FileReadInputSchema,
  riskLevel: 'read',
  egress: 'none',
  loading: 'eager',
  card: 'read',
  present: ({ input, output }) =>
    output.ok && 'image' in output
      ? readCard({
          path: input.path,
          text: `${output.image.media_type}, ${output.image.bytes} bytes`,
        })
      : output.ok && 'document' in output
        ? readCard({
            path: input.path,
            text:
              `${output.document.media_type}, ${output.document.pages} page(s), ` +
              `${output.document.bytes} bytes`,
          })
        : output.ok
          ? readCard({
              path: input.path,
              text: output.content,
              truncated: output.truncated,
              sections: output.total_lines,
            })
          : failureText(output.reason),
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
        // An image or a PDF is read whole or not at all: no line window of it
        // means anything. Above the whole-read cap an image is not passed; a
        // PDF is, up to its own cap.
        const large = sniffAttachmentMediaType(await readHead(path));
        if (large === PDF_MEDIA_TYPE && info.size <= MAX_MODEL_PDF_BYTES) {
          return await attachmentResult(input, path, await readFile(path), large, ctx);
        }
        if (large !== null) {
          return {
            ok: false,
            reason:
              `${describe(input.path, large, info.size)}, and it was not read: ` +
              (large === PDF_MEDIA_TYPE
                ? `a PDF can be passed at ${formatBytes(MAX_MODEL_PDF_BYTES)} at most; a lighter ` +
                  'copy (fewer pages, a lower scan resolution) can be.'
                : `an image can be passed at ${formatBytes(MAX_MODEL_IMAGE_BYTES)} at most; a ` +
                  'smaller copy (scaled down, or JPEG) can be.'),
          };
        }
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
        const { windowLines, totalLines, sha256 } = await readLinesWindowed(
          path,
          startIdx,
          startIdx + limit,
          undefined,
          MAX_READ_FILE_BYTES,
        );
        // Les octets LUS (tout le flux), rapportés au seam (tool_call_reads).
        ctx.reportReadContent?.(path, sha256);
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

      const bytes = await readFile(path);
      const attachmentType = sniffAttachmentMediaType(bytes.subarray(0, SNIFF_BYTES));
      if (attachmentType !== null) {
        return await attachmentResult(input, path, bytes, attachmentType, ctx);
      }
      // Les octets LUS, rapportés au seam (tool_call_reads) ; puis décodés comme avant.
      ctx.reportReadContent?.(path, createHash('sha256').update(bytes).digest('hex'));
      const raw = bytes.toString('utf8');
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
