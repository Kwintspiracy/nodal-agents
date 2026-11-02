// file-ops/file-overview.ts — several files read and several folder trees listed, in ONE call
//
// Why (#932): a decision about several files (where each goes, what each is)
// needed one `file_read` per file and one `file_list` per folder, each call
// followed by a model turn, each turn re-reading the whole context. This tool
// returns, in one result, what those calls would: each file read through the
// SAME path as `file_read` (`readWorkspaceFile`), and each folder's tree,
// folders only. It reads; it decides nothing and changes nothing.

import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';
import type { ToolContext, ToolDefinition } from '../../types';
import { filesCard } from '../../presenters';
import { resolveAndCheckPath, WorkspaceError } from './workspace';
import { readWorkspaceFile, type FileReadOutput } from './file-read';

/** Files one call reads at most. */
export const OVERVIEW_MAX_FILES = 20;
/** Folders whose tree one call lists at most. */
export const OVERVIEW_MAX_ROOTS = 5;
/** Characters of a text file returned at most. */
export const OVERVIEW_TEXT_CHARS = 4000;
/** Pages of a PDF attached at most. */
export const OVERVIEW_PDF_PAGES = 3;
/** Levels of a folder tree listed below its root. */
export const OVERVIEW_TREE_DEPTH = 3;
/** Folders listed at most per root. */
export const OVERVIEW_TREE_MAX_FOLDERS = 200;

/** Lines read for a text file before its characters are cut (`file_read`'s own maximum). */
const TEXT_LINES = 2000;

export const FileOverviewInputSchema = z.object({
  files: z
    .array(z.string().min(1))
    .min(1)
    .max(OVERVIEW_MAX_FILES)
    .describe(
      `Paths of the files to read, 1 to ${OVERVIEW_MAX_FILES}, as file_read takes them ` +
        '(relative to a workspace, label prefix for multi-workspace agents).',
    ),
  roots: z
    .array(z.string().min(1))
    .max(OVERVIEW_MAX_ROOTS)
    .optional()
    .default([])
    .describe(
      `Folders whose tree to list, 0 to ${OVERVIEW_MAX_ROOTS}, as file_list takes them. ` +
        `Folders only, ${OVERVIEW_TREE_DEPTH} levels deep, ${OVERVIEW_TREE_MAX_FOLDERS} per folder at most.`,
    ),
});

export type FileOverviewInput = z.infer<typeof FileOverviewInputSchema>;

/** What the file is on disk, said for every file that was read. */
type FileFacts = { path: string; name: string; bytes: number; modified: string };

export type FileOverviewFile =
  | (FileFacts & { ok: true; text: string; note?: string })
  /** `attachment`: its rank (1-based) among the files this result attaches, in order. */
  | (FileFacts & { ok: true; image: { media_type: string; bytes: number }; attachment: number })
  | (FileFacts & {
      ok: true;
      document: {
        media_type: string;
        bytes: number;
        pages: number;
        attached_pages: string;
        note?: string;
      };
      attachment: number;
    })
  | { path: string; ok: false; reason: string };

export type FileOverviewRoot =
  | { root: string; ok: true; folders: string[]; note?: string }
  | { root: string; ok: false; reason: string };

export type FileOverviewOutput = { ok: true; files: FileOverviewFile[]; roots: FileOverviewRoot[] };

const PDF_WINDOW = {
  pages: OVERVIEW_PDF_PAGES,
  why: `file_overview attaches ${OVERVIEW_PDF_PAGES} pages of a PDF at most; file_read reads more`,
};

function errorReason(err: unknown, path: string): string {
  if (err instanceof WorkspaceError) return err.message;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return `Not found: "${path}".`;
  return `"${path}" could not be read: ${err instanceof Error ? err.message : String(err)}`;
}

/** The text `file_read` returned, cut to `OVERVIEW_TEXT_CHARS`, saying when and how to read on. */
function boundedText(read: Extract<FileReadOutput, { content: string }>): {
  text: string;
  note?: string;
} {
  const cutChars = read.content.length > OVERVIEW_TEXT_CHARS;
  if (!cutChars && !read.truncated) return { text: read.content };
  const text = cutChars ? read.content.slice(0, OVERVIEW_TEXT_CHARS) : read.content;
  const shown = cutChars
    ? `the first ${OVERVIEW_TEXT_CHARS} characters`
    : `lines 1-${read.end_line}`;
  return {
    text,
    note:
      `Cut: ${shown} of ${read.total_lines} line(s) are shown; file_read reads the rest ` +
      '(offset, limit).',
  };
}

async function overviewFile(path: string, ctx: ToolContext, attached: () => number) {
  try {
    const read = await readWorkspaceFile({ path, limit: TEXT_LINES }, ctx, PDF_WINDOW);
    if (!read.ok) return { path, ok: false as const, reason: read.reason };
    const info = await stat(await resolveAndCheckPath(ctx, path));
    const facts: FileFacts = {
      path,
      name: basename(path.replace(/\\/g, '/')),
      bytes: info.size,
      modified: info.mtime.toISOString(),
    };
    if ('image' in read)
      return { ...facts, ok: true as const, image: read.image, attachment: attached() };
    if ('document' in read) {
      return { ...facts, ok: true as const, document: read.document, attachment: attached() };
    }
    return { ...facts, ok: true as const, ...boundedText(read) };
  } catch (err) {
    return { path, ok: false as const, reason: errorReason(err, path) };
  }
}

/**
 * A folder's tree, folders only, breadth first so that a cut drops the deepest
 * and last ones. Each folder is named as the root was given, then its path
 * below it (`Documents/Taxes/2025`): the form `file_move` takes. A link is not
 * followed, like `file_list`.
 */
async function overviewRoot(root: string, ctx: ToolContext): Promise<FileOverviewRoot> {
  try {
    const abs = await resolveAndCheckPath(ctx, root);
    if (!(await stat(abs)).isDirectory()) {
      return { root, ok: false, reason: `Not a directory: "${root}".` };
    }
    const prefix = root.replace(/\\/g, '/').replace(/\/+$/, '');
    const folders: string[] = [];
    let full = false;
    let deeper = false;
    let level: Array<{ abs: string; rel: string }> = [{ abs, rel: prefix }];
    for (let depth = 1; level.length > 0; depth++) {
      const next: Array<{ abs: string; rel: string }> = [];
      for (const dir of level) {
        const subdirs = (await readdir(dir.abs, { withFileTypes: true }))
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
          .sort((a, b) => a.localeCompare(b));
        if (depth > OVERVIEW_TREE_DEPTH) {
          if (subdirs.length > 0) deeper = true;
          continue;
        }
        for (const name of subdirs) {
          if (folders.length >= OVERVIEW_TREE_MAX_FOLDERS) {
            full = true;
            break;
          }
          const rel = `${dir.rel}/${name}`;
          folders.push(rel);
          next.push({ abs: join(dir.abs, name), rel });
        }
        if (full) break;
      }
      if (full || depth > OVERVIEW_TREE_DEPTH) break;
      level = next;
    }
    const cuts = [
      ...(full ? [`only the first ${OVERVIEW_TREE_MAX_FOLDERS} folders are listed`] : []),
      ...(deeper
        ? [`folders more than ${OVERVIEW_TREE_DEPTH} levels below it are not listed`]
        : []),
    ];
    return cuts.length === 0
      ? { root, ok: true, folders }
      : { root, ok: true, folders, note: `Cut: ${cuts.join(', and ')}; file_list lists a folder.` };
  } catch (err) {
    return { root, ok: false, reason: errorReason(err, root) };
  }
}

export const fileOverviewTool: ToolDefinition<typeof FileOverviewInputSchema, FileOverviewOutput> =
  {
    name: 'file_overview',
    label: 'Look over files and folders',
    summary:
      'Read several files and list several folder trees in one call. Reads only, changes nothing.',
    description:
      `Read up to ${OVERVIEW_MAX_FILES} files and list up to ${OVERVIEW_MAX_ROOTS} folder trees in ONE ` +
      'call, instead of one file_read or file_list per item. Each file comes with its name, size ' +
      `and modified date, and what file_read gives for it: its text (the first ${OVERVIEW_TEXT_CHARS} ` +
      `characters), or the image or PDF itself (its first ${OVERVIEW_PDF_PAGES} pages) when your ` +
      'model takes it, attached in the order of `attachment`. Each root comes with its subfolders, ' +
      `folders only, ${OVERVIEW_TREE_DEPTH} levels deep, ${OVERVIEW_TREE_MAX_FOLDERS} at most. A file ` +
      'or folder that cannot be read says why in its own entry; the others are still returned, and ' +
      'whatever was cut says so. Use file_read to read more of a file.',
    inputSchema: FileOverviewInputSchema,
    riskLevel: 'read',
    egress: 'none',
    loading: 'eager',
    card: 'files',
    present: ({ output }) =>
      filesCard([
        ...output.files.map((f) => ({
          path: f.path,
          action: 'listed' as const,
          ...(f.ok ? { bytes: f.bytes } : {}),
          detail: !f.ok
            ? f.reason
            : 'image' in f
              ? `${f.image.media_type}, attached`
              : 'document' in f
                ? `${f.document.pages} page(s), pages ${f.document.attached_pages} attached`
                : 'text',
        })),
        ...output.roots.map((r) => ({
          path: r.root,
          action: 'listed' as const,
          detail: r.ok ? `${r.folders.length} folder(s)` : r.reason,
        })),
      ]),
    execute: async (input, ctx) => {
      // The files this call attaches, counted in order, so each entry can say
      // which attachment is its own. `executeTool` admits each one against the
      // request's budget; a refused one is said in its entry, never dropped.
      let count = 0;
      const attach = ctx.attachForModel;
      const counting: ToolContext =
        attach === undefined
          ? ctx
          : {
              ...ctx,
              attachForModel: (attachment) => {
                const outcome = attach(attachment);
                if (outcome.attached) count++;
                return outcome;
              },
            };
      const files: FileOverviewFile[] = [];
      // One after the other: attachments keep the order of `files`.
      for (const path of input.files) files.push(await overviewFile(path, counting, () => count));
      const roots: FileOverviewRoot[] = [];
      for (const root of input.roots) roots.push(await overviewRoot(root, ctx));
      return { ok: true, files, roots };
    },
  };
