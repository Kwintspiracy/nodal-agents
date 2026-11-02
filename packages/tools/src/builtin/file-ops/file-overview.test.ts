// file-overview.test.ts — several files read and several folder trees listed in ONE call (#932).
//
// Real temp-dir fixtures, through the seam (`executeTool`), so what is asserted
// is what the model receives: the result's text and the files it attaches.
// Nothing here is about filing: text, PDF, image, a missing file, a path
// outside the workspace, a tree deeper and wider than the caps, the schema's
// bound, and the request's attachment budget.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { MODEL_REQUEST_MAX_IMAGES } from '@nodal-agents/shared';
import { buildTestPdf } from '@nodal-agents/test-kit';
import { systemSkills } from '@nodal-agents/catalog';
import { executeTool } from '../../execute';
import { ALWAYS_ON_TOOLS, ALWAYS_ON_TOOL_DOCS } from '../index';
import { LOAD_TOOLS_NAME } from '../load-tools';
import { CHAT_CONTEXT_READ_TOOLS, UNTRUSTED_TOOL_NAMES } from '@nodal-agents/shared';
import type { ModelAttachmentInput } from '../../model-images';
import type { ToolContext, ToolExecutionResult } from '../../types';
import {
  fileOverviewTool,
  FileOverviewInputSchema,
  OVERVIEW_MAX_FILES,
  OVERVIEW_MAX_ROOTS,
  OVERVIEW_PDF_PAGES,
  OVERVIEW_TEXT_CHARS,
  OVERVIEW_TREE_DEPTH,
  OVERVIEW_TREE_MAX_FOLDERS,
  OVERVIEW_FOLDER_MAX_FILES,
  OVERVIEW_TREE_MAX_FILES,
  type FileOverviewOutput,
} from './file-overview';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('png body'),
]);
const LONG_PDF = buildTestPdf(
  Array.from({ length: OVERVIEW_PDF_PAGES + 4 }, (_, k) => ({ text: `Page ${k + 1}` })),
);
const SHORT_PDF = buildTestPdf([{ text: 'Only page' }]);
const TAKES_ALL: ModelAttachmentInput = { image: { sees: true }, pdf: { sees: true } };
const NO_PDFS: ModelAttachmentInput = {
  image: { sees: true },
  pdf: { sees: false, reason: 'the model this agent runs does not take PDF documents as input' },
};

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let ws: string;
let outside: string;

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  seed = await seedMinimal(db);
  ws = await realpath(await mkdtemp(join(tmpdir(), 'nodal-overview-')));
  outside = await realpath(await mkdtemp(join(tmpdir(), 'nodal-overview-out-')));
  await mkdir(join(ws, 'inbox'));
  await writeFile(join(ws, 'inbox', 'note.txt'), 'Water bill, March\nAmount due: 42\n');
  await writeFile(join(ws, 'inbox', 'long.txt'), 'x'.repeat(OVERVIEW_TEXT_CHARS + 500));
  await writeFile(join(ws, 'inbox', 'shot.png'), PNG);
  await writeFile(join(ws, 'inbox', 'long.pdf'), LONG_PDF);
  await writeFile(join(ws, 'inbox', 'short.pdf'), SHORT_PDF);
  await writeFile(join(outside, 'secret.txt'), 'not yours');
  // A tree 5 levels deep: a/b/c/d/e, with files that must never be listed.
  await mkdir(join(ws, 'deep', 'a', 'b', 'c', 'd', 'e'), { recursive: true });
  await writeFile(join(ws, 'deep', 'a', 'file.txt'), 'a file, not a folder');
  // File names over the caps: 60 in one folder, then 10 folders of 50.
  await mkdir(join(ws, 'names', 'big'), { recursive: true });
  for (let k = 0; k < OVERVIEW_FOLDER_MAX_FILES + 10; k++) {
    await writeFile(join(ws, 'names', 'big', `n${String(k).padStart(3, '0')}.txt`), '');
  }
  for (let d = 0; d < 10; d++) {
    const dir = join(ws, 'names', `d${String(d).padStart(2, '0')}`);
    await mkdir(dir);
    for (let k = 0; k < 50; k++) await writeFile(join(dir, `m${k}.txt`), '');
  }
  // A tree wider than the cap, one level.
  for (let k = 0; k < OVERVIEW_TREE_MAX_FOLDERS + 10; k++) {
    await mkdir(join(ws, 'wide', `f${String(k).padStart(3, '0')}`), { recursive: true });
  }
});

afterAll(async () => {
  await rm(ws, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

function ctx(modelInput?: ModelAttachmentInput): ToolContext {
  return {
    db: db as unknown as ToolContext['db'],
    entityId: seed.entityId,
    agentId: seed.agentId,
    jobId: seed.jobId,
    jobChatId: null,
    workspaces: [{ label: 'ws', path: ws }],
    ...(modelInput ? { modelInput } : {}),
  };
}

const opts = { approvalRules: [], onApprovalRequired: async () => {} } as never;

async function overview(
  input: { files: string[]; roots?: string[] },
  modelInput?: ModelAttachmentInput,
): Promise<{ out: FileOverviewOutput; result: ToolExecutionResult }> {
  const result = await executeTool(fileOverviewTool as never, input, ctx(modelInput), opts);
  if (result.outcome !== 'success') throw new Error(`expected success, got ${result.outcome}`);
  return { out: result.output as FileOverviewOutput, result };
}

/** The text of each page of an attached PDF. */
async function pdfPages(data: string): Promise<string[]> {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(Buffer.from(data, 'base64')) });
  try {
    return (await parser.getText()).pages.map((p) => p.text.trim());
  } finally {
    await parser.destroy();
  }
}

describe('file_overview — files @cap:travailler-sur-des-fichiers/moteur', () => {
  it('returns a text file whole, with its name, size and date, as file_read reads it', async () => {
    const { out, result } = await overview({ files: ['inbox/note.txt'] }, TAKES_ALL);
    expect(out.files).toHaveLength(1);
    const [f] = out.files;
    expect(f).toMatchObject({
      path: 'inbox/note.txt',
      ok: true,
      name: 'note.txt',
      bytes: 'Water bill, March\nAmount due: 42\n'.length,
      text: 'Water bill, March\nAmount due: 42\n',
    });
    expect(f && 'note' in f ? f.note : undefined).toBeUndefined();
    expect(Number.isNaN(Date.parse((f as { modified: string }).modified))).toBe(false);
    if (result.outcome !== 'success') throw new Error('expected success');
    expect(result.attachments).toBeUndefined();
  });

  it('cuts a long text at its bound, and says so and how to read on', async () => {
    const { out } = await overview({ files: ['inbox/long.txt'] });
    const [f] = out.files;
    if (!f?.ok || !('text' in f)) throw new Error('expected a text entry');
    expect(f.text).toBe('x'.repeat(OVERVIEW_TEXT_CHARS));
    expect(f.note).toContain(`the first ${OVERVIEW_TEXT_CHARS} characters`);
    expect(f.note).toContain('file_read reads the rest');
  });

  it('attaches the first pages of a PDF only, says which, and how to read more', async () => {
    const { out, result } = await overview({ files: ['inbox/long.pdf'] }, TAKES_ALL);
    const [f] = out.files;
    if (!f?.ok || !('document' in f)) throw new Error('expected a document entry');
    expect(f.attachment).toBe(1);
    expect(f.document).toMatchObject({
      media_type: 'application/pdf',
      pages: OVERVIEW_PDF_PAGES + 4,
      attached_pages: `1-${OVERVIEW_PDF_PAGES}`,
    });
    expect(f.document.note).toContain(
      `file_overview attaches ${OVERVIEW_PDF_PAGES} pages of a PDF at most; file_read reads more`,
    );
    expect(f.document.note).toContain(`"pages": "${OVERVIEW_PDF_PAGES + 1}-`);
    if (result.outcome !== 'success') throw new Error('expected success');
    expect(result.attachments).toHaveLength(1);
    const [doc] = result.attachments ?? [];
    expect(doc?.pages).toBe(OVERVIEW_PDF_PAGES);
    expect(await pdfPages(doc!.data)).toEqual(['Page 1', 'Page 2', 'Page 3']);
  });

  it('attaches several files in one result, in the order of `files`, each entry naming its rank', async () => {
    const { out, result } = await overview(
      { files: ['inbox/shot.png', 'inbox/note.txt', 'inbox/short.pdf'] },
      TAKES_ALL,
    );
    expect(out.files.map((f) => (f.ok && 'attachment' in f ? f.attachment : null))).toEqual([
      1,
      null,
      2,
    ]);
    if (result.outcome !== 'success') throw new Error('expected success');
    expect(result.attachments?.map((a) => a.mediaType)).toEqual(['image/png', 'application/pdf']);
    expect(result.attachments?.[0]?.data).toBe(PNG.toString('base64'));
  });

  it('a file the model cannot take is said in its entry; the others are still returned', async () => {
    const { out, result } = await overview(
      { files: ['inbox/short.pdf', 'inbox/shot.png'] },
      NO_PDFS,
    );
    expect(out.files[0]).toMatchObject({ path: 'inbox/short.pdf', ok: false });
    expect((out.files[0] as { reason: string }).reason).toContain(
      'does not take PDF documents as input',
    );
    expect(out.files[1]).toMatchObject({ path: 'inbox/shot.png', ok: true, attachment: 1 });
    if (result.outcome !== 'success') throw new Error('expected success');
    expect(result.attachments?.map((a) => a.mediaType)).toEqual(['image/png']);
  });

  it('a missing file and a path outside the workspace are said in their entries; the others are returned', async () => {
    const { out } = await overview({
      files: ['inbox/gone.txt', join(outside, 'secret.txt'), 'inbox/note.txt'],
    });
    expect(out.files).toHaveLength(3);
    expect(out.files[0]).toEqual({
      path: 'inbox/gone.txt',
      ok: false,
      reason: 'File not found: "inbox/gone.txt".',
    });
    expect(out.files[1]).toMatchObject({ ok: false });
    expect(JSON.stringify(out.files[1])).not.toContain('not yours');
    expect((out.files[1] as { reason: string }).reason.length).toBeGreaterThan(0);
    expect(out.files[2]).toMatchObject({ ok: true, text: 'Water bill, March\nAmount due: 42\n' });
  });

  it(`refuses more than ${OVERVIEW_MAX_FILES} files, and no file at all, by its schema`, () => {
    const many = Array.from({ length: OVERVIEW_MAX_FILES + 1 }, (_, k) => `f${k}.txt`);
    expect(FileOverviewInputSchema.safeParse({ files: many }).success).toBe(false);
    expect(FileOverviewInputSchema.safeParse({ files: many.slice(1) }).success).toBe(true);
    expect(FileOverviewInputSchema.safeParse({ files: [] }).success).toBe(false);
  });

  it('refused by the seam: 21 files never run', async () => {
    const many = Array.from({ length: OVERVIEW_MAX_FILES + 1 }, () => 'inbox/note.txt');
    const r = await executeTool(fileOverviewTool as never, { files: many }, ctx(), opts);
    expect(r.outcome).toBe('error');
  });

  it('PDF pages over the request budget: a refused file is said in its entry, never dropped', async () => {
    const files = Array.from(
      { length: Math.ceil(MODEL_REQUEST_MAX_IMAGES / OVERVIEW_PDF_PAGES) + 1 },
      () => 'inbox/long.pdf',
    );
    const { out, result } = await overview({ files }, TAKES_ALL);
    expect(out.files).toHaveLength(files.length);
    const refused = out.files.filter((f) => !f.ok);
    expect(refused.length).toBeGreaterThan(0);
    expect((refused[0] as { reason: string }).reason).toContain(
      'a request to a model carries at most',
    );
    if (result.outcome !== 'success') throw new Error('expected success');
    const pages = (result.attachments ?? []).reduce((n, a) => n + (a.pages ?? 1), 0);
    expect(pages).toBeLessThanOrEqual(MODEL_REQUEST_MAX_IMAGES);
  });
});

describe('file_overview — folder trees @cap:travailler-sur-des-fichiers/moteur', () => {
  it(`lists the root and its folders ${OVERVIEW_TREE_DEPTH} levels deep, each with its file names, and says what is deeper`, async () => {
    const { out } = await overview({ files: ['inbox/note.txt'], roots: ['deep'] });
    expect(out.roots).toEqual([
      {
        root: 'deep',
        ok: true,
        folders: [
          { path: 'deep', files: [] },
          { path: 'deep/a', files: ['file.txt'] },
          { path: 'deep/a/b', files: [] },
          { path: 'deep/a/b/c', files: [] },
        ],
        note: `Cut: folders more than ${OVERVIEW_TREE_DEPTH} levels below it are not listed. file_list lists a folder.`,
      },
    ]);
  });

  it(`stops at ${OVERVIEW_TREE_MAX_FOLDERS} folders below a root, and says so`, async () => {
    const { out } = await overview({ files: ['inbox/note.txt'], roots: ['wide', 'inbox/'] });
    const [wide, inbox] = out.roots;
    if (!wide?.ok) throw new Error('expected the wide tree');
    expect(wide.folders).toHaveLength(OVERVIEW_TREE_MAX_FOLDERS + 1);
    expect(wide.folders.map((f) => f.path).slice(0, 2)).toEqual(['wide', 'wide/f000']);
    expect(wide.note).toContain(
      `the result lists ${OVERVIEW_TREE_MAX_FOLDERS} folders below its roots at most, and some below this one are not listed`,
    );
    // A root with files and no subfolder: its own names, nothing cut, nothing said.
    expect(inbox).toEqual({
      root: 'inbox/',
      ok: true,
      folders: [
        {
          path: 'inbox',
          files: ['long.pdf', 'long.txt', 'note.txt', 'short.pdf', 'shot.png'],
        },
      ],
    });
  });

  it(`names ${OVERVIEW_FOLDER_MAX_FILES} files per folder and ${OVERVIEW_TREE_MAX_FILES} per tree at most, and counts the others`, async () => {
    const { out } = await overview({ files: ['inbox/note.txt'], roots: ['names'] });
    const [tree] = out.roots;
    if (!tree?.ok) throw new Error('expected the names tree');
    const big = tree.folders.find((f) => f.path === 'names/big');
    expect(big?.files).toHaveLength(OVERVIEW_FOLDER_MAX_FILES);
    expect(big?.files[0]).toBe('n000.txt');
    expect(big?.files_not_listed).toBe(10);
    expect(tree.folders.reduce((n, f) => n + f.files.length, 0)).toBe(OVERVIEW_TREE_MAX_FILES);
    expect(tree.folders.at(-1)).toEqual({ path: 'names/d09', files: [], files_not_listed: 50 });
    expect(tree.note).toContain('"files_not_listed" counts the others');
  });

  // Live run of #935: "Your folders" named six folders and a bound of five
  // roots refused the call, a whole turn lost. The bounds are on what the
  // result carries, across all roots, never on how many roots are named.
  it(`accepts 6 and ${OVERVIEW_MAX_ROOTS} roots, refuses ${OVERVIEW_MAX_ROOTS + 1}`, async () => {
    const roots = (n: number): string[] => Array.from({ length: n }, () => 'deep');
    const parse = (n: number): boolean =>
      FileOverviewInputSchema.safeParse({ files: ['inbox/note.txt'], roots: roots(n) }).success;
    expect(parse(6)).toBe(true);
    expect(parse(OVERVIEW_MAX_ROOTS)).toBe(true);
    expect(parse(OVERVIEW_MAX_ROOTS + 1)).toBe(false);
    const { out } = await overview({ files: ['inbox/note.txt'], roots: roots(6) });
    expect(out.roots).toHaveLength(6);
    expect(out.roots.every((r) => r.ok && r.folders.length === 4)).toBe(true);
  });

  it(`bounds folders to ${OVERVIEW_TREE_MAX_FOLDERS} across ALL roots, and each cut root says so`, async () => {
    const { out } = await overview({ files: ['inbox/note.txt'], roots: ['deep', 'wide', 'inbox'] });
    const [deep, wide, inbox] = out.roots;
    if (!deep?.ok || !wide?.ok || !inbox?.ok) throw new Error('expected three trees');
    const below = out.roots.reduce((n, r) => n + (r.ok ? r.folders.length - 1 : 0), 0);
    expect(below).toBe(OVERVIEW_TREE_MAX_FOLDERS);
    // Breadth first across the roots: deep/a (level 1) is in, deep/a/b is cut.
    expect(deep.folders.map((f) => f.path)).toEqual(['deep', 'deep/a']);
    expect(wide.folders).toHaveLength(OVERVIEW_TREE_MAX_FOLDERS);
    const said = `the result lists ${OVERVIEW_TREE_MAX_FOLDERS} folders below its roots at most`;
    expect(deep.note).toContain(said);
    expect(wide.note).toContain(said);
    expect(inbox).toEqual({
      root: 'inbox',
      ok: true,
      folders: [
        { path: 'inbox', files: ['long.pdf', 'long.txt', 'note.txt', 'short.pdf', 'shot.png'] },
      ],
    });
  });

  it(`bounds file names to ${OVERVIEW_TREE_MAX_FILES} across ALL roots, and the cut root says so`, async () => {
    const { out } = await overview({ files: ['inbox/note.txt'], roots: ['names', 'inbox'] });
    const [names, inbox] = out.roots;
    if (!names?.ok || !inbox?.ok) throw new Error('expected two trees');
    const listed = out.roots.reduce(
      (n, r) => n + (r.ok ? r.folders.reduce((m, f) => m + f.files.length, 0) : 0),
      0,
    );
    expect(listed).toBe(OVERVIEW_TREE_MAX_FILES);
    // inbox's 5 names come in at level 0, so 5 fewer names fit under names/.
    expect(inbox.folders[0]?.files).toHaveLength(5);
    expect(inbox.note).toBeUndefined();
    expect(names.folders.find((f) => f.path === 'names/d08')).toEqual(
      expect.objectContaining({ files_not_listed: 5 }),
    );
    expect(names.note).toContain(`and the result ${OVERVIEW_TREE_MAX_FILES}`);
  });

  it('a missing root, a file given as root and a root outside the workspace are said in their entries', async () => {
    const { out } = await overview({
      files: ['inbox/note.txt'],
      roots: ['nowhere', 'inbox/note.txt', outside, 'deep'],
    });
    expect(out.roots[0]).toEqual({ root: 'nowhere', ok: false, reason: 'Not found: "nowhere".' });
    expect(out.roots[1]).toEqual({
      root: 'inbox/note.txt',
      ok: false,
      reason: 'Not a directory: "inbox/note.txt".',
    });
    expect(out.roots[2]).toMatchObject({ root: outside, ok: false });
    expect(out.roots[3]).toMatchObject({ root: 'deep', ok: true });
    expect(out.files[0]).toMatchObject({ ok: true });
  });
});

describe('file_overview — offered like file_read @cap:travailler-sur-des-fichiers/moteur', () => {
  it('is a read, always on, documented for its owner, a chat-context read, and its text is framed as untrusted', () => {
    expect(fileOverviewTool.riskLevel).toBe('read');
    expect(fileOverviewTool.egress).toBe('none');
    expect(ALWAYS_ON_TOOLS).toContain('file_overview');
    expect(ALWAYS_ON_TOOL_DOCS.map((d) => d.name)).toEqual([...ALWAYS_ON_TOOLS]);
    expect(CHAT_CONTEXT_READ_TOOLS).toContain('file_overview');
    expect(UNTRUSTED_TOOL_NAMES.has('file_overview')).toBe(true);
  });

  it('the file-filing skill names only always-on tools, so it unlocks none (`requiredBuiltins` empty)', () => {
    const fileFilingSkill = systemSkills.find((s) => s.slug === 'file-filing');
    if (fileFilingSkill === undefined) throw new Error('the file-filing skill is gone');
    const named = [...fileFilingSkill.content.matchAll(/`([a-z]+_[a-z_]+)`/g)].map((m) => m[1]);
    expect(named).toContain('file_overview');
    expect(named).toContain('file_move');
    // Every tool it names is held by every agent: always on, or the loader.
    for (const tool of named) {
      expect([...ALWAYS_ON_TOOLS, LOAD_TOOLS_NAME] as string[]).toContain(tool);
    }
    // A deferred tool it names is loaded by the method itself, in the turn
    // that looks, never in a turn of its own (live run of #932).
    const deferred = ALWAYS_ON_TOOL_DOCS.filter(
      (d) => named.includes(d.name) && d.loading === 'deferred',
    ).map((d) => d.name);
    expect(deferred).toContain('file_move');
    for (const tool of deferred) {
      expect(fileFilingSkill.content).toContain(`\`load_tools\` for \`${tool}\``);
    }
    expect(fileFilingSkill.requiredBuiltins).toEqual([]);
  });
});
