// file-ops/file-overview.ts — several files read and several folder trees listed, in ONE call
//
// Why (#932): a decision about several files (where each goes, what each is)
// needed one `file_read` per file and one `file_list` per folder, each call
// followed by a model turn, each turn re-reading the whole context. This tool
// returns, in one result, what those calls would: each file read through the
// SAME path as `file_read` (`readWorkspaceFile`), and each folder's tree,
// each folder with the names of its files (what a move onto an existing name
// needs to know). It reads; it decides nothing and changes nothing.

import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';
import type { ToolContext, ToolDefinition } from '../../types';
import { filesCard } from '../../presenters';
import { resolveAndCheckPath, WorkspaceError } from './workspace';
import { readWorkspaceFile, type FileReadOutput } from './file-read';

/** Files one call reads at most. */
export const OVERVIEW_MAX_FILES = 20;
/**
 * Folders whose tree one call lists at most. The bounds that matter are on
 * what the result carries (folders, file names), across all roots: a count
 * of roots refused a call that named six folders (live run of #935).
 */
export const OVERVIEW_MAX_ROOTS = 20;
/** Characters of a text file returned at most. */
export const OVERVIEW_TEXT_CHARS = 4000;
/** Pages of a PDF attached at most. */
export const OVERVIEW_PDF_PAGES = 3;
/** Levels of a folder tree listed below its root. */
export const OVERVIEW_TREE_DEPTH = 3;
/** Folders listed at most in one result, below its roots, all roots together. */
export const OVERVIEW_TREE_MAX_FOLDERS = 200;
/** File names listed at most per folder of a tree. */
export const OVERVIEW_FOLDER_MAX_FILES = 50;
/** File names listed at most in one result, all roots together (`file_list`'s own cap). */
export const OVERVIEW_TREE_MAX_FILES = 500;

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
        `Each folder with its file names, ${OVERVIEW_TREE_DEPTH} levels deep, ${OVERVIEW_TREE_MAX_FOLDERS} folders and ${OVERVIEW_TREE_MAX_FILES} file names in all at most.`,
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

/** A folder of a tree, and the names of the files it holds (`files_not_listed`: the others, counted). */
export type FileOverviewFolder = { path: string; files: string[]; files_not_listed?: number };

export type FileOverviewRoot =
  | { root: string; ok: true; folders: FileOverviewFolder[]; note?: string }
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
 * The trees of every root, breadth first ACROSS the roots: each root itself,
 * then every folder one level below any root, then two... so that a cut of the
 * result's bounds drops the deepest and last folders, whichever root they are
 * in, and never a whole root because another came first. Each folder comes
 * with the names of the files it holds, and is named as its root was given,
 * then its path below it (`Documents/Taxes/2025`): the form `file_move` takes.
 * A link is not followed, like `file_list`. A root that is cut says so in its
 * own `note`.
 */
async function overviewRoots(
  roots: readonly string[],
  ctx: ToolContext,
): Promise<FileOverviewRoot[]> {
  type Tree = { folders: FileOverviewFolder[]; full: boolean; deeper: boolean; filesCut: boolean };
  const out: Array<FileOverviewRoot | Tree> = [];
  const queue: Array<{ at: number; abs: string; rel: string; depth: number }> = [];
  for (const [at, root] of roots.entries()) {
    try {
      const abs = await resolveAndCheckPath(ctx, root);
      if (!(await stat(abs)).isDirectory()) {
        out.push({ root, ok: false, reason: `Not a directory: "${root}".` });
        continue;
      }
      out.push({ folders: [], full: false, deeper: false, filesCut: false });
      queue.push({ at, abs, rel: root.replace(/\\/g, '/').replace(/\/+$/, ''), depth: 0 });
    } catch (err) {
      out.push({ root, ok: false, reason: errorReason(err, root) });
    }
  }
  let below = 0;
  let names = 0;
  const byName = (a: string, b: string): number => a.localeCompare(b);
  for (let i = 0; i < queue.length; i++) {
    const dir = queue[i]!;
    const tree = out[dir.at]!;
    if ('ok' in tree) continue; // the root failed further down: said once, in its entry
    let entries;
    try {
      entries = await readdir(dir.abs, { withFileTypes: true });
    } catch (err) {
      out[dir.at] = { root: roots[dir.at]!, ok: false, reason: errorReason(err, dir.rel) };
      continue;
    }
    const subdirs = entries
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort(byName);
    const files = entries
      .filter((d) => !d.isDirectory())
      .map((d) => d.name)
      .sort(byName);
    const shown = files.slice(
      0,
      Math.max(0, Math.min(OVERVIEW_FOLDER_MAX_FILES, OVERVIEW_TREE_MAX_FILES - names)),
    );
    names += shown.length;
    if (shown.length < files.length) tree.filesCut = true;
    tree.folders.push({
      path: dir.rel,
      files: shown,
      ...(shown.length < files.length ? { files_not_listed: files.length - shown.length } : {}),
    });
    if (dir.depth === OVERVIEW_TREE_DEPTH) {
      if (subdirs.length > 0) tree.deeper = true;
      continue;
    }
    for (const name of subdirs) {
      if (below >= OVERVIEW_TREE_MAX_FOLDERS) {
        tree.full = true;
        break;
      }
      below++;
      queue.push({
        at: dir.at,
        abs: join(dir.abs, name),
        rel: `${dir.rel}/${name}`,
        depth: dir.depth + 1,
      });
    }
  }
  return out.map((tree, at) => {
    if ('ok' in tree) return tree;
    const root = roots[at]!;
    const cuts = [
      ...(tree.full
        ? [
            `the result lists ${OVERVIEW_TREE_MAX_FOLDERS} folders below its roots at most, and ` +
              'some below this one are not listed',
          ]
        : []),
      ...(tree.deeper
        ? [`folders more than ${OVERVIEW_TREE_DEPTH} levels below it are not listed`]
        : []),
      ...(tree.filesCut
        ? [
            `a folder lists ${OVERVIEW_FOLDER_MAX_FILES} file names at most, and the result ` +
              `${OVERVIEW_TREE_MAX_FILES}; "files_not_listed" counts the others`,
          ]
        : []),
    ];
    return cuts.length === 0
      ? { root, ok: true, folders: tree.folders }
      : {
          root,
          ok: true,
          folders: tree.folders,
          note: `Cut: ${cuts.join('; ')}. file_list lists a folder.`,
        };
  });
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
      'model takes it, attached in the order of `attachment`. Each root comes with itself and its ' +
      `subfolders, ${OVERVIEW_TREE_DEPTH} levels deep, each with the names of the files it holds ` +
      `(${OVERVIEW_FOLDER_MAX_FILES} per folder; ${OVERVIEW_TREE_MAX_FOLDERS} folders and ${OVERVIEW_TREE_MAX_FILES} names in all ` +
      'at most, a cut root saying so). A file ' +
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
      roots.push(...(await overviewRoots(input.roots, ctx)));
      return { ok: true, files, roots };
    },
  };
