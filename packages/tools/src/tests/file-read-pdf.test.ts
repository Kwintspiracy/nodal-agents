// file-read-pdf.test.ts — a PDF in a folder the agent can read reaches a model
// that takes PDFs as the document itself, through the same seam as an image
// (`executeTool` → `ctx.attachForModel`); to a model that does not, the call
// says why, and never hands over the bytes as text (#903).
//
// The need (2026-10-31): the owner sends printer scans — image-only PDFs — to
// be filed, and `file_read` returned them as undecodable lines. Nothing here
// is only that case: a PDF with a text page and a scanned page, a model that
// takes PDFs, one that sees images but not PDFs, a run that says nothing, a
// PDF above the cap, one with more pages than a request carries, a file that
// only starts like a PDF, a binary named `.pdf` and a PDF named `.bin`.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { toolCalls, eq } from '@nodal-agents/db';
import { MODEL_REQUEST_MAX_IMAGES } from '@nodal-agents/shared';
import { buildTestPdf } from '@nodal-agents/test-kit';
import { executeTool } from '../execute';
import { fileReadTool } from '../builtin/file-ops/file-read';
import {
  MAX_MODEL_PDF_BYTES,
  admitModelAttachment,
  countPdfPages,
  sniffAttachmentMediaType,
  type ModelAttachmentInput,
} from '../model-images';
import type { ToolContext, ToolExecutionResult } from '../types';

const SCAN = buildTestPdf([{ text: 'Invoice 4217 from ACME' }, { scanned: 'INVOICE 4217 ACME' }]);
const SCAN_B64 = SCAN.toString('base64');
const TOO_LONG = buildTestPdf(
  Array.from({ length: MODEL_REQUEST_MAX_IMAGES + 1 }, (_, k) => ({ text: `Page ${k + 1}` })),
);
// Starts like a PDF, is not one.
const BROKEN = Buffer.from('%PDF-1.4\nthis is not a pdf at all\n');
// A binary that is no PDF, whatever its name says.
const BINARY = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xfe, 0xff, 0x10, 0x20, 0x30, 0x40]);

const TAKES_PDFS: ModelAttachmentInput = { image: { sees: true }, pdf: { sees: true } };
const NO_PDFS: ModelAttachmentInput = {
  image: { sees: true },
  pdf: {
    sees: false,
    reason: 'the model this agent runs (z-ai/glm-5.3-flash) does not take PDF documents as input',
  },
};

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let ws: string;

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  seed = await seedMinimal(db);
  ws = await realpath(await mkdtemp(join(tmpdir(), 'nodal-read-pdf-')));
  await writeFile(join(ws, 'scan.pdf'), SCAN);
  await writeFile(join(ws, 'scan.bin'), SCAN);
  await writeFile(join(ws, 'long.pdf'), TOO_LONG);
  await writeFile(join(ws, 'broken.pdf'), BROKEN);
  await writeFile(join(ws, 'binary.pdf'), BINARY);
  // Above the cap: a real PDF, then padding after its end, as a large scan has.
  await writeFile(
    join(ws, 'huge.pdf'),
    Buffer.concat([SCAN, Buffer.alloc(MAX_MODEL_PDF_BYTES + 1024, 0x20)]),
  );
});

afterAll(async () => {
  await rm(ws, { recursive: true, force: true });
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

async function read(path: string, input?: ModelAttachmentInput): Promise<ToolExecutionResult> {
  return executeTool(fileReadTool as never, { path }, ctx(input), opts);
}

/** The output the audit row of the last file_read on `path` keeps. */
async function recorded(path: string): Promise<unknown> {
  const rows = await db
    .select({ toolInput: toolCalls.toolInput, toolOutput: toolCalls.toolOutput })
    .from(toolCalls)
    .where(eq(toolCalls.jobId, seed.jobId));
  const row = rows.filter((r) => (r.toolInput as { path?: string }).path === path).at(-1);
  return JSON.parse(String(row?.toolOutput));
}

describe('file_read — a PDF reaches a model that takes PDFs @cap:travailler-sur-des-fichiers/moteur', () => {
  it.each([
    ['scan.pdf'],
    // The bytes say what the file is, never its name.
    ['scan.bin'],
  ])(
    '%s: the document itself, its bytes intact, its pages counted, never on the row',
    async (path) => {
      const r = await read(path, TAKES_PDFS);
      if (r.outcome !== 'success') throw new Error('expected success');
      expect(r.attachments).toEqual([{ mediaType: 'application/pdf', data: SCAN_B64, pages: 2 }]);
      const said = {
        ok: true,
        document: { media_type: 'application/pdf', bytes: SCAN.length, pages: 2 },
      };
      expect(r.output).toEqual(said);
      // The row is an audit, not a store: type, size and pages, no base64.
      const row = await recorded(path);
      expect(row).toEqual(said);
      expect(JSON.stringify(row)).not.toContain(SCAN_B64);
    },
  );

  it('a model that sees images but takes no PDF: refused with its reason, no file, no bytes as text', async () => {
    const r = await read('scan.pdf', NO_PDFS);
    if (r.outcome !== 'success') throw new Error('expected the tool to answer');
    expect(r.attachments).toBeUndefined();
    expect(r.output).toEqual({
      ok: false,
      reason:
        `"scan.pdf" is a PDF document (2 page(s), ${Math.round(SCAN.length / 1024)} KB), and it ` +
        'was not read: the model this agent runs (z-ai/glm-5.3-flash) does not take PDF ' +
        'documents as input.',
    });
    expect(JSON.stringify(r.output)).not.toContain('%PDF');
  });

  it('a run that says nothing about its model passes no PDF, and says so', async () => {
    const r = await read('scan.pdf');
    if (r.outcome !== 'success') throw new Error('expected the tool to answer');
    expect(r.attachments).toBeUndefined();
    expect((r.output as { reason: string }).reason).toContain(
      'and it was not read: this run does not pass PDF documents to a model.',
    );
  });

  it('a PDF above the cap is refused with its size and the cap, before it is opened', async () => {
    const r = await read('huge.pdf', TAKES_PDFS);
    if (r.outcome !== 'success') throw new Error('expected the tool to answer');
    expect(r.attachments).toBeUndefined();
    const reason = (r.output as { reason: string }).reason;
    expect(reason).toContain('"huge.pdf" is a PDF document (10.0 MiB), and it was not read');
    expect(reason).toContain('a PDF can be passed at 10.0 MiB at most');
  });

  it('a PDF with more pages than a request carries is refused, the pages and the limit named', async () => {
    const r = await read('long.pdf', TAKES_PDFS);
    if (r.outcome !== 'success') throw new Error('expected the tool to answer');
    expect(r.attachments).toBeUndefined();
    expect((r.output as { reason: string }).reason).toContain(
      `the PDF has ${MODEL_REQUEST_MAX_IMAGES + 1} pages, and a request to a model carries at ` +
        `most ${MODEL_REQUEST_MAX_IMAGES} images, a PDF page counting as one`,
    );
  });

  it('a file that only starts like a PDF is refused as one, why said, never read as text', async () => {
    const r = await read('broken.pdf', TAKES_PDFS);
    if (r.outcome !== 'success') throw new Error('expected the tool to answer');
    expect(r.attachments).toBeUndefined();
    const out = r.output as { ok: boolean; reason: string };
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('"broken.pdf" is a PDF document');
    expect(out.reason).toContain('it could not be opened as a PDF');
    expect(out.reason).not.toContain('this is not a pdf at all');
  });

  it('a binary named .pdf is not a PDF: nothing attached, read as the file it is', async () => {
    const r = await read('binary.pdf', TAKES_PDFS);
    if (r.outcome !== 'success') throw new Error('expected the tool to answer');
    expect(r.attachments).toBeUndefined();
    expect(r.output).toMatchObject({ ok: true, total_lines: 1 });
    expect(r.output).not.toHaveProperty('document');
  });
});

describe('the one rule, for a PDF @cap:travailler-sur-des-fichiers/moteur', () => {
  it('reads a PDF from its first bytes, and counts its pages', async () => {
    expect(sniffAttachmentMediaType(SCAN)).toBe('application/pdf');
    expect(sniffAttachmentMediaType(BINARY)).toBe(null);
    expect(sniffAttachmentMediaType(Buffer.from('a %PDF- later in the text'))).toBe(null);
    expect(await countPdfPages(SCAN)).toEqual({ pages: 2 });
    expect(await countPdfPages(TOO_LONG)).toEqual({ pages: MODEL_REQUEST_MAX_IMAGES + 1 });
    expect('error' in (await countPdfPages(BROKEN))).toBe(true);
  });

  it('the fixture is what it claims: a text page, and a scanned page with no text in it', async () => {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(SCAN) });
    try {
      const pages = (await parser.getText()).pages.map((p) => p.text.trim());
      expect(pages).toEqual(['Invoice 4217 from ACME', '']);
    } finally {
      await parser.destroy();
    }
  });

  it('a PDF spends the request budget a page per image, shared with the images', () => {
    const pdf = (pages: number) => ({ mediaType: 'application/pdf', data: SCAN_B64, pages });
    const png = { mediaType: 'image/png', data: Buffer.from('png').toString('base64') };
    const images = Array.from({ length: 15 }, () => png);
    // 15 images + a 5-page PDF fill the 20; a 6-page one does not fit.
    expect(admitModelAttachment(TAKES_PDFS, pdf(5), images)).toEqual({ attached: true });
    const refused = admitModelAttachment(TAKES_PDFS, pdf(6), images);
    expect(refused.attached).toBe(false);
    expect(refused).toMatchObject({
      reason: expect.stringContaining(
        'this call already attached 15 file(s) (15 image(s) or PDF page(s)',
      ),
    });
    // A PDF whose pages were not counted is not passed: its cost is not known.
    expect(
      admitModelAttachment(TAKES_PDFS, { mediaType: 'application/pdf', data: SCAN_B64 }),
    ).toEqual({ attached: false, reason: 'its pages were not counted, so its cost is not known' });
    // The capability is the PDF's, not the image's.
    expect(admitModelAttachment(NO_PDFS, pdf(1))).toEqual({
      attached: false,
      reason: (NO_PDFS.pdf as { reason: string }).reason,
    });
    expect(admitModelAttachment(NO_PDFS, png)).toEqual({ attached: true });
  });
});
