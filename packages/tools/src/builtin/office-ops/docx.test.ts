// docx.test.ts — round-trip + fidelity + security tests for docx_* tools

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import JSZip from 'jszip';
import {
  Document,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  Packer,
  WidthType,
} from 'docx';
import {
  docxReadTool,
  docxCreateTool,
  docxAppendParagraphsTool,
  docxReplaceTextTool,
} from './docx';
import type { ToolContext } from '../../types';

// ─── Setup ────────────────────────────────────────────────────────────────────

let WORKSPACE: string;

beforeAll(async () => {
  WORKSPACE = await mkdtemp(join(tmpdir(), 'nodal-docx-ws-'));
});

afterAll(async () => {
  await rm(WORKSPACE, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(WORKSPACE, { recursive: true, force: true });
  await mkdir(WORKSPACE, { recursive: true });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ctx(): ToolContext {
  return {
    jobId: '00000000-0000-0000-0000-000000000aaa',
    agentId: '00000000-0000-0000-0000-000000000bbb',
    entityId: '00000000-0000-0000-0000-000000000ccc',
    db: undefined as unknown as ToolContext['db'],
    jobChatId: null,
    workspaces: [{ label: 'ws', path: WORKSPACE }],
  };
}

function ctxNone(): ToolContext {
  return { ...ctx(), workspaces: undefined };
}

async function readDocumentXml(relPath: string): Promise<string> {
  const buf = await readFile(join(WORKSPACE, relPath));
  const zip = await JSZip.loadAsync(buf);
  const file = zip.file('word/document.xml');
  if (!file) throw new Error('word/document.xml missing from output archive');
  return file.async('string');
}

/** Builds a real, structurally-valid .docx (heading style + table) via the docx
 * library directly, bypassing docx_create, to prove docx_append_paragraphs
 * preserves formatting it never touches. */
async function buildFixtureBuffer(): Promise<Buffer> {
  const table = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          new TableCell({ children: [new Paragraph({ children: [new TextRun('R1C1')] })] }),
          new TableCell({ children: [new Paragraph({ children: [new TextRun('R1C2')] })] }),
        ],
      }),
    ],
  });
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun('Original Heading')],
          }),
          table,
          new Paragraph({ children: [new TextRun('Original trailing paragraph.')] }),
        ],
      },
    ],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

/** Builds a real, docx-lib-generated MULTI-SECTION document: two `sections`
 * entries produce a section-break <w:sectPr> NESTED inside an earlier
 * paragraph's <w:pPr> (mid-body), in addition to the actual final <w:sectPr>
 * that is the direct child of <w:body>. Regression fixture for C1: an earlier
 * version of FINAL_SECTPR_RE matched the nested sectPr first (regex engines
 * try the leftmost start position, and the lazy quantifier backtracked past
 * it), splicing new paragraphs INSIDE that <w:pPr> — invalid OOXML. */
async function buildMultiSectionDocx(): Promise<Buffer> {
  const doc = new Document({
    sections: [
      { children: [new Paragraph({ children: [new TextRun('Section 1 para')] })] },
      { children: [new Paragraph({ children: [new TextRun('Section 2 para')] })] },
    ],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

/** Builds a minimal one-paragraph .docx, then hand-splits its single run into
 * two <w:t> runs — simulates the real-world "text fragmented across runs" case
 * (spell-check/tracked-change boundaries) that docx_replace_text must detect
 * but not silently "fix". */
async function buildFragmentedRunsDocx(): Promise<Buffer> {
  const doc = new Document({
    sections: [{ children: [new Paragraph({ children: [new TextRun('PLACEHOLDER')] })] }],
  });
  const buf = Buffer.from(await Packer.toBuffer(doc));
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file('word/document.xml')!.async('string');
  const split = xml.replace(
    '<w:r><w:t xml:space="preserve">PLACEHOLDER</w:t></w:r>',
    '<w:r><w:t xml:space="preserve">Hello</w:t></w:r><w:r><w:t xml:space="preserve">World</w:t></w:r>',
  );
  expect(split).not.toBe(xml); // sanity: the splice actually matched something
  zip.file('word/document.xml', split);
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}

/** One paragraph with a single-run occurrence ("Hello there") and a second
 * paragraph with the same word fragmented across runs ("Hel" + "lo fragmented")
 * — proves a single replace call can both succeed AND report a fragment. */
async function buildMixedRunsDocx(): Promise<Buffer> {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ children: [new TextRun('Hello there, single run.')] }),
          new Paragraph({ children: [new TextRun('PLACEHOLDER')] }),
        ],
      },
    ],
  });
  const buf = Buffer.from(await Packer.toBuffer(doc));
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file('word/document.xml')!.async('string');
  const split = xml.replace(
    '<w:r><w:t xml:space="preserve">PLACEHOLDER</w:t></w:r>',
    '<w:r><w:t xml:space="preserve">Hel</w:t></w:r><w:r><w:t xml:space="preserve">lo fragmented</w:t></w:r>',
  );
  expect(split).not.toBe(xml);
  zip.file('word/document.xml', split);
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}

async function buildDocxWithBoldAndPlainRun(): Promise<Buffer> {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            children: [new TextRun({ text: 'keep bold', bold: true }), new TextRun(' target text')],
          }),
        ],
      },
    ],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

/** Builds a minimal one-paragraph .docx, then hand-splices its run to contain
 * a numeric XML character reference (&#233; = 'é') alongside the search term
 * — real Word documents emit these for characters outside the editor's
 * default entity set. Regression fixture for m2: decodeXmlEntities used to
 * ignore numeric references, so a run like this got re-escaped into the
 * literal text "&amp;#233;" on write (visibly wrong in Word) instead of
 * round-tripping the accented character. */
async function buildDocxWithNumericEntity(): Promise<Buffer> {
  const doc = new Document({
    sections: [{ children: [new Paragraph({ children: [new TextRun('PLACEHOLDER')] })] }],
  });
  const buf = Buffer.from(await Packer.toBuffer(doc));
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file('word/document.xml')!.async('string');
  const spliced = xml.replace(
    '<w:r><w:t xml:space="preserve">PLACEHOLDER</w:t></w:r>',
    '<w:r><w:t xml:space="preserve">caf&#233; TARGET word</w:t></w:r>',
  );
  expect(spliced).not.toBe(xml);
  zip.file('word/document.xml', spliced);
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}

// Minimal real PNG (valid IHDR/IDAT/IEND chunks, correct CRCs) at an arbitrary
// solid color — enough for docx-lib to embed and for our own header-only
// dimension sniffer to read back correctly.
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) >>> 0, 0);
  return Buffer.concat([len, Buffer.from(type, 'ascii'), data, crc]);
}

function makePng(width: number, height: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const rowSize = width * 3;
  const raw = Buffer.alloc((rowSize + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (rowSize + 1)] = 0; // filter: none
    for (let x = 0; x < rowSize; x++) raw[y * (rowSize + 1) + 1 + x] = 128;
  }
  const idatData = zlib.deflateSync(raw);
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idatData),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Minimal JPEG marker stream: SOI + SOF0 (carrying real width/height) + EOI.
// Not a decodable image, but structurally valid enough for our dimension
// sniffer (and docx-lib, which embeds bytes opaquely without decoding them).
function makeMinimalJpeg(width: number, height: number): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const sof0 = Buffer.from([
    0xff,
    0xc0, // SOF0 marker
    0x00,
    0x0b, // segment length = 11
    0x08, // precision
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x01, // numComponents
    0x01,
    0x11,
    0x00, // component: id, sampling, quant table
  ]);
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, sof0, eoi]);
}

// ─── docx_create — base paragraphs (existing behaviour) ────────────────────────

describe('docx_create', () => {
  it('creates a .docx and docx_read can retrieve the paragraph text', async () => {
    const create = await docxCreateTool.execute(
      {
        path: 'hello.docx',
        paragraphs: [
          { text: 'Hello, World!', heading: 1 },
          { text: 'This is a paragraph.', bold: false },
          { text: 'Bold text here.', bold: true },
        ],
        overwrite: false,
      },
      ctx(),
    );
    expect(create.ok).toBe(true);
    if (!create.ok) throw new Error(create.reason);

    const read = await docxReadTool.execute({ path: 'hello.docx' }, ctx());
    if (!read.ok) throw new Error(read.reason);

    expect(read.text).toContain('Hello, World!');
    expect(read.text).toContain('This is a paragraph.');
    expect(read.text).toContain('Bold text here.');
    expect(read.truncated).toBe(false);
  });

  it('returns paragraph list in paragraphs array', async () => {
    await docxCreateTool.execute(
      {
        path: 'paras.docx',
        paragraphs: [{ text: 'Para One' }, { text: 'Para Two' }],
        overwrite: false,
      },
      ctx(),
    );

    const read = await docxReadTool.execute({ path: 'paras.docx' }, ctx());
    if (!read.ok) throw new Error(read.reason);
    expect(read.paragraphs).toContain('Para One');
    expect(read.paragraphs).toContain('Para Two');
  });

  it('refuses to overwrite when overwrite:false', async () => {
    await docxCreateTool.execute(
      { path: 'doc.docx', paragraphs: [{ text: 'original' }], overwrite: false },
      ctx(),
    );
    const result = await docxCreateTool.execute(
      { path: 'doc.docx', paragraphs: [{ text: 'new' }], overwrite: false },
      ctx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toMatch(/already exists/i);
  });

  it('overwrites when overwrite:true', async () => {
    await docxCreateTool.execute(
      { path: 'doc.docx', paragraphs: [{ text: 'original' }], overwrite: false },
      ctx(),
    );
    const result = await docxCreateTool.execute(
      { path: 'doc.docx', paragraphs: [{ text: 'replaced' }], overwrite: true },
      ctx(),
    );
    expect(result.ok).toBe(true);

    const read = await docxReadTool.execute({ path: 'doc.docx' }, ctx());
    if (!read.ok) throw new Error(read.reason);
    expect(read.text).toContain('replaced');
  });
});

// ─── docx_create — lists, tables, images, page breaks ──────────────────────────

describe('docx_create — enriched content blocks', () => {
  it('creates bullet and numbered list paragraphs', async () => {
    const create = await docxCreateTool.execute(
      {
        path: 'lists.docx',
        paragraphs: [
          { text: 'Bullet one', list: 'bullet' },
          { text: 'Numbered one', list: 'numbered' },
          { text: 'Numbered two', list: 'numbered' },
        ],
        overwrite: false,
      },
      ctx(),
    );
    expect(create.ok).toBe(true);
    if (!create.ok) throw new Error(create.reason);

    const xml = await readDocumentXml('lists.docx');
    expect(xml).toContain('<w:numPr>');

    const buf = await readFile(join(WORKSPACE, 'lists.docx'));
    const zip = await JSZip.loadAsync(buf);
    const numberingXml = await zip.file('word/numbering.xml')!.async('string');
    expect(numberingXml).toContain('w:val="decimal"');

    const read = await docxReadTool.execute({ path: 'lists.docx' }, ctx());
    if (!read.ok) throw new Error(read.reason);
    expect(read.text).toContain('Bullet one');
    expect(read.text).toContain('Numbered one');
    expect(read.text).toContain('Numbered two');
  });

  it('creates a table block with a bold header row', async () => {
    const create = await docxCreateTool.execute(
      {
        path: 'table.docx',
        paragraphs: [
          { text: 'Report' },
          {
            table: {
              rows: [
                ['Name', 'Score'],
                ['Alice', '90'],
                ['Bob', '85'],
              ],
              header: true,
            },
          },
        ],
        overwrite: false,
      },
      ctx(),
    );
    expect(create.ok).toBe(true);
    if (!create.ok) throw new Error(create.reason);

    const read = await docxReadTool.execute({ path: 'table.docx' }, ctx());
    if (!read.ok) throw new Error(read.reason);
    expect(read.text).toContain('Name');
    expect(read.text).toContain('Score');
    expect(read.text).toContain('Alice');
    expect(read.text).toContain('90');

    const xml = await readDocumentXml('table.docx');
    expect(xml).toContain('<w:tbl>');
    const headerCellIdx = xml.indexOf('Name');
    const headerRunStart = xml.lastIndexOf('<w:r>', headerCellIdx);
    expect(xml.slice(headerRunStart, headerCellIdx)).toContain('<w:b/>');
    // A body cell (not the header row) must NOT be bold.
    const aliceIdx = xml.indexOf('Alice');
    const aliceRunStart = xml.lastIndexOf('<w:r>', aliceIdx);
    expect(xml.slice(aliceRunStart, aliceIdx)).not.toContain('<w:b/>');
  });

  it('embeds a PNG image scaled down to the max width, aspect ratio preserved', async () => {
    const png = makePng(1200, 900); // 4:3
    await writeFile(join(WORKSPACE, 'photo.png'), png);

    const create = await docxCreateTool.execute(
      { path: 'img.docx', paragraphs: [{ image_path: 'photo.png' }], overwrite: false },
      ctx(),
    );
    expect(create.ok).toBe(true);
    if (!create.ok) throw new Error(create.reason);

    const xml = await readDocumentXml('img.docx');
    // 1200x900 -> scaled to max width 600 -> 600x450 -> EMU = px * 9525
    expect(xml).toContain('cx="5715000" cy="4286250"');
    expect(xml).toContain('pic:pic');
  });

  it('embeds a JPEG image scaled down, and rejects a file that is not a real image', async () => {
    const jpeg = makeMinimalJpeg(800, 400); // 2:1
    await writeFile(join(WORKSPACE, 'photo.jpg'), jpeg);

    const create = await docxCreateTool.execute(
      { path: 'img2.docx', paragraphs: [{ image_path: 'photo.jpg' }], overwrite: false },
      ctx(),
    );
    expect(create.ok).toBe(true);
    if (!create.ok) throw new Error(create.reason);

    const xml = await readDocumentXml('img2.docx');
    // 800x400 -> scaled to max width 600 -> 600x300 -> EMU = px * 9525
    expect(xml).toContain('cx="5715000" cy="2857500"');

    await writeFile(join(WORKSPACE, 'notreally.png'), Buffer.from('this is not an image'));
    const bad = await docxCreateTool.execute(
      { path: 'imgbad.docx', paragraphs: [{ image_path: 'notreally.png' }], overwrite: false },
      ctx(),
    );
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error('expected failure');
    expect(bad.reason).toMatch(/png or jpeg/i);
  });

  it('fails loud when image_path escapes the workspace', async () => {
    const create = await docxCreateTool.execute(
      { path: 'imgesc.docx', paragraphs: [{ image_path: '../escape.png' }], overwrite: false },
      ctx(),
    );
    expect(create.ok).toBe(false);
    if (create.ok) throw new Error('expected failure');
    expect(create.reason).toMatch(/traversal|escape|workspace|outside|not found/i);
  });

  it('inserts a page break', async () => {
    const create = await docxCreateTool.execute(
      {
        path: 'break.docx',
        paragraphs: [{ text: 'Before' }, { page_break: true }, { text: 'After' }],
        overwrite: false,
      },
      ctx(),
    );
    expect(create.ok).toBe(true);
    if (!create.ok) throw new Error(create.reason);

    const xml = await readDocumentXml('break.docx');
    expect(xml).toContain('<w:br w:type="page"/>');
  });
});

// ─── docx_read ────────────────────────────────────────────────────────────────

describe('docx_read', () => {
  it('returns ok:false when file not found', async () => {
    const result = await docxReadTool.execute({ path: 'missing.docx' }, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toMatch(/not found/i);
  });

  it('returns ok:false when workspace is not configured', async () => {
    const result = await docxReadTool.execute({ path: 'any.docx' }, ctxNone());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toMatch(/workspace/i);
  });

  it('blocks path traversal', async () => {
    const result = await docxReadTool.execute({ path: '../escape.docx' }, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toMatch(/traversal|escape|workspace|outside/i);
  });

  it('already includes table cell text (mammoth walks the whole body) — no change needed here', async () => {
    await docxCreateTool.execute(
      {
        path: 'tbl.docx',
        paragraphs: [{ table: { rows: [['CellA', 'CellB']] } }],
        overwrite: false,
      },
      ctx(),
    );
    const read = await docxReadTool.execute({ path: 'tbl.docx' }, ctx());
    if (!read.ok) throw new Error(read.reason);
    expect(read.text).toContain('CellA');
    expect(read.text).toContain('CellB');
  });
});

// ─── docx_append_paragraphs — fidelity-preserving in-place edit ───────────────

describe('docx_append_paragraphs', () => {
  it('is classified riskLevel=write (fidelity-preserving append, not the old lossy rebuild)', () => {
    expect(docxAppendParagraphsTool.riskLevel).toBe('write');
    expect(docxAppendParagraphsTool.defaultApproval).toBeUndefined();
  });

  it('appends paragraphs — resulting document contains original + new text', async () => {
    await docxCreateTool.execute(
      { path: 'app.docx', paragraphs: [{ text: 'Original content.' }], overwrite: false },
      ctx(),
    );

    const append = await docxAppendParagraphsTool.execute(
      { path: 'app.docx', paragraphs: [{ text: 'Appended paragraph.' }] },
      ctx(),
    );
    expect(append.ok).toBe(true);
    if (!append.ok) throw new Error(append.reason);
    expect(append.paragraphs_appended).toBe(1);

    const read = await docxReadTool.execute({ path: 'app.docx' }, ctx());
    if (!read.ok) throw new Error(read.reason);
    expect(read.text).toContain('Original content.');
    expect(read.text).toContain('Appended paragraph.');
  });

  it('preserves original formatting (heading style + table) untouched and inserts the new paragraph before the final section properties', async () => {
    const fixture = await buildFixtureBuffer();
    await writeFile(join(WORKSPACE, 'fixture.docx'), fixture);

    const append = await docxAppendParagraphsTool.execute(
      { path: 'fixture.docx', paragraphs: [{ text: 'Appended fidelity paragraph.', bold: true }] },
      ctx(),
    );
    expect(append.ok).toBe(true);
    if (!append.ok) throw new Error(append.reason);

    // Content-level: everything still readable, old AND new content present.
    const read = await docxReadTool.execute({ path: 'fixture.docx' }, ctx());
    if (!read.ok) throw new Error(read.reason);
    expect(read.text).toContain('Original Heading');
    expect(read.text).toContain('R1C1');
    expect(read.text).toContain('R1C2');
    expect(read.text).toContain('Original trailing paragraph.');
    expect(read.text).toContain('Appended fidelity paragraph.');

    // XML-level: the original heading style + table markup are byte-identical
    // to what buildFixtureBuffer produced (not rebuilt from plain text), and
    // the new paragraph lands before the body's closing section properties.
    const xml = await readDocumentXml('fixture.docx');
    expect(xml).toContain('<w:pStyle w:val="Heading1"/>');
    expect(xml).toContain('<w:tbl>');
    expect(xml).toContain('R1C1');
    expect(xml).toContain('<w:b/>');
    expect(xml).toContain('Appended fidelity paragraph.');

    const appendedIdx = xml.indexOf('Appended fidelity paragraph.');
    const sectPrIdx = xml.indexOf('<w:sectPr');
    expect(appendedIdx).toBeGreaterThan(-1);
    expect(sectPrIdx).toBeGreaterThan(-1);
    expect(appendedIdx).toBeLessThan(sectPrIdx);

    const buf = await readFile(join(WORKSPACE, 'fixture.docx'));
    const zip = await JSZip.loadAsync(buf);
    const styles = await zip.file('word/styles.xml')!.async('string');
    expect(styles).toContain('Heading1');
  });

  it('C1 regression: on a multi-section document, inserts before the FINAL section properties, never inside an earlier section-break <w:pPr>', async () => {
    const fixture = await buildMultiSectionDocx();
    await writeFile(join(WORKSPACE, 'multisection.docx'), fixture);

    // Sanity check on the fixture itself: it really does contain a section-break
    // sectPr nested inside a <w:pPr>, distinct from the final body-level one.
    const beforeXml = await readDocumentXml('multisection.docx');
    expect(beforeXml).toContain('<w:pPr><w:sectPr>');
    const nestedSectPrIdx = beforeXml.indexOf('<w:pPr><w:sectPr>');
    const finalSectPrIdxBefore = beforeXml.lastIndexOf('<w:sectPr');
    expect(nestedSectPrIdx).toBeLessThan(finalSectPrIdxBefore); // two distinct sectPr elements

    const append = await docxAppendParagraphsTool.execute(
      { path: 'multisection.docx', paragraphs: [{ text: 'Appended after both sections.' }] },
      ctx(),
    );
    expect(append.ok).toBe(true);
    if (!append.ok) throw new Error(append.reason);

    const xml = await readDocumentXml('multisection.docx');

    // The section-break sectPr nested in the first paragraph's <w:pPr> must be
    // completely untouched — still immediately opens with <w:pPr><w:sectPr>.
    expect(xml).toContain('<w:pPr><w:sectPr>');

    const newParaIdx = xml.indexOf('Appended after both sections.');
    const nestedSectPrIdxAfter = xml.indexOf('<w:pPr><w:sectPr>');
    const finalSectPrIdxAfter = xml.lastIndexOf('<w:sectPr');
    const section2Idx = xml.indexOf('Section 2 para');

    expect(newParaIdx).toBeGreaterThan(-1);
    // New paragraph must NOT have landed inside/before the nested section-break
    // <w:pPr> (the C1 bug) — it must come AFTER both original sections' content.
    expect(newParaIdx).toBeGreaterThan(nestedSectPrIdxAfter);
    expect(newParaIdx).toBeGreaterThan(section2Idx);
    // ...and still land before the true final <w:sectPr>.
    expect(newParaIdx).toBeLessThan(finalSectPrIdxAfter);
    // Exactly one new <w:p> was added around the new text — the nested sectPr's
    // own <w:pPr> must not have gained any extra content either.
    expect(xml).toContain('<w:pPr><w:sectPr><w:pgSz');

    // Whole document must still be well-formed enough for mammoth to read both
    // original sections AND the appended text back out.
    const read = await docxReadTool.execute({ path: 'multisection.docx' }, ctx());
    if (!read.ok) throw new Error(read.reason);
    expect(read.text).toContain('Section 1 para');
    expect(read.text).toContain('Section 2 para');
    expect(read.text).toContain('Appended after both sections.');
  });

  it('escapes special XML characters in appended text', async () => {
    await docxCreateTool.execute(
      { path: 'appesc.docx', paragraphs: [{ text: 'Base.' }], overwrite: false },
      ctx(),
    );
    const append = await docxAppendParagraphsTool.execute(
      { path: 'appesc.docx', paragraphs: [{ text: 'Tom & Jerry <3 "quotes"' }] },
      ctx(),
    );
    expect(append.ok).toBe(true);
    if (!append.ok) throw new Error(append.reason);

    const read = await docxReadTool.execute({ path: 'appesc.docx' }, ctx());
    if (!read.ok) throw new Error(read.reason);
    expect(read.text).toContain('Tom & Jerry <3 "quotes"');
  });

  it('rejects a `list` field on append paragraphs via strict schema validation (fail loud, not silently dropped)', () => {
    const parsed = docxAppendParagraphsTool.inputSchema.safeParse({
      path: 'x.docx',
      paragraphs: [{ text: 'hi', list: 'bullet' }],
    });
    expect(parsed.success).toBe(false);
  });

  it('fails loud when document.xml has no <w:body>', async () => {
    const zip = new JSZip();
    zip.file(
      'word/document.xml',
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:NOTBODY/></w:document>',
    );
    const buf = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
    await writeFile(join(WORKSPACE, 'broken.docx'), buf);

    const result = await docxAppendParagraphsTool.execute(
      { path: 'broken.docx', paragraphs: [{ text: 'x' }] },
      ctx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toMatch(/w:body/i);
  });

  it('fails loud when word/document.xml is missing entirely', async () => {
    const zip = new JSZip();
    zip.file('word/other.xml', '<x/>');
    const buf = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
    await writeFile(join(WORKSPACE, 'missing-doc.docx'), buf);

    const result = await docxAppendParagraphsTool.execute(
      { path: 'missing-doc.docx', paragraphs: [{ text: 'x' }] },
      ctx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toMatch(/document\.xml/i);
  });

  it('fails loud on corrupt (non-zip) file content', async () => {
    await writeFile(join(WORKSPACE, 'garbage.docx'), Buffer.from('this is not a zip file at all'));
    const result = await docxAppendParagraphsTool.execute(
      { path: 'garbage.docx', paragraphs: [{ text: 'x' }] },
      ctx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toMatch(/corrupt|unreadable/i);
  });
});

// ─── docx_replace_text ─────────────────────────────────────────────────────────

describe('docx_replace_text', () => {
  it('replaces every literal occurrence contained in a single run', async () => {
    await docxCreateTool.execute(
      { path: 'r1.docx', paragraphs: [{ text: 'Hello World, Hello World.' }], overwrite: false },
      ctx(),
    );
    const result = await docxReplaceTextTool.execute(
      { path: 'r1.docx', find: 'World', replace: 'Nodal', match_case: true },
      ctx(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.replaced).toBe(2);
    expect(result.skipped_fragmented).toBe(0);

    const read = await docxReadTool.execute({ path: 'r1.docx' }, ctx());
    if (!read.ok) throw new Error(read.reason);
    expect(read.text).toContain('Hello Nodal, Hello Nodal.');
    expect(read.text).not.toContain('World');
  });

  it('match_case:false matches regardless of case', async () => {
    await docxCreateTool.execute(
      { path: 'r2.docx', paragraphs: [{ text: 'foo FOO Foo' }], overwrite: false },
      ctx(),
    );
    const result = await docxReplaceTextTool.execute(
      { path: 'r2.docx', find: 'foo', replace: 'bar', match_case: false },
      ctx(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.replaced).toBe(3);

    const read = await docxReadTool.execute({ path: 'r2.docx' }, ctx());
    if (!read.ok) throw new Error(read.reason);
    expect(read.text.trim()).toBe('bar bar bar');
  });

  it('match_case:true (default) only matches exact case', async () => {
    await docxCreateTool.execute(
      { path: 'r3.docx', paragraphs: [{ text: 'foo FOO Foo' }], overwrite: false },
      ctx(),
    );
    const result = await docxReplaceTextTool.execute(
      { path: 'r3.docx', find: 'foo', replace: 'bar', match_case: true },
      ctx(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.replaced).toBe(1);

    const read = await docxReadTool.execute({ path: 'r3.docx' }, ctx());
    if (!read.ok) throw new Error(read.reason);
    expect(read.text.trim()).toBe('bar FOO Foo');
  });

  it('fails loud when the text is not found at all', async () => {
    await docxCreateTool.execute(
      { path: 'r4.docx', paragraphs: [{ text: 'nothing to see here' }], overwrite: false },
      ctx(),
    );
    const result = await docxReplaceTextTool.execute(
      { path: 'r4.docx', find: 'zzz-not-present', replace: 'x', match_case: true },
      ctx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toMatch(/not found/i);
  });

  it('detects text fragmented across runs, reports it, and leaves the document unmodified', async () => {
    const buf = await buildFragmentedRunsDocx();
    await writeFile(join(WORKSPACE, 'fragmented.docx'), buf);

    // "loWo" spans the Hello|World run boundary — present in the concatenated
    // paragraph text but in neither run individually.
    const result = await docxReplaceTextTool.execute(
      { path: 'fragmented.docx', find: 'loWo', replace: 'XX', match_case: true },
      ctx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure (fragmented occurrence, nothing replaceable)');
    expect(result.reason).toMatch(/fragment/i);

    const read = await docxReadTool.execute({ path: 'fragmented.docx' }, ctx());
    if (!read.ok) throw new Error(read.reason);
    expect(read.text).toContain('HelloWorld');
  });

  it('replaces the single-run occurrence and reports the fragmented one separately in the same call', async () => {
    const buf = await buildMixedRunsDocx();
    await writeFile(join(WORKSPACE, 'mixed.docx'), buf);

    const result = await docxReplaceTextTool.execute(
      { path: 'mixed.docx', find: 'Hello', replace: 'HI', match_case: true },
      ctx(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.replaced).toBe(1);
    expect(result.skipped_fragmented).toBe(1);

    const read = await docxReadTool.execute({ path: 'mixed.docx' }, ctx());
    if (!read.ok) throw new Error(read.reason);
    expect(read.text).toContain('HI there, single run.');
    expect(read.text).toContain('Hello fragmented'); // fragmented occurrence left untouched
  });

  it('does not touch unrelated runs or their formatting', async () => {
    const buf = await buildDocxWithBoldAndPlainRun();
    await writeFile(join(WORKSPACE, 'fmt.docx'), buf);

    const result = await docxReplaceTextTool.execute(
      { path: 'fmt.docx', find: 'target', replace: 'CHANGED', match_case: true },
      ctx(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.replaced).toBe(1);

    const xml = await readDocumentXml('fmt.docx');
    expect(xml).toContain('<w:b/>');
    expect(xml).toContain('keep bold');
    expect(xml).toContain('CHANGED text');
    expect(xml).not.toContain('target text');
  });

  it('escapes special XML characters in the replacement text', async () => {
    await docxCreateTool.execute(
      { path: 'esc.docx', paragraphs: [{ text: 'Value: PLACEHOLDER end.' }], overwrite: false },
      ctx(),
    );
    const result = await docxReplaceTextTool.execute(
      { path: 'esc.docx', find: 'PLACEHOLDER', replace: 'A & B <C> "D"', match_case: true },
      ctx(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);

    const read = await docxReadTool.execute({ path: 'esc.docx' }, ctx());
    if (!read.ok) throw new Error(read.reason);
    expect(read.text).toContain('Value: A & B <C> "D" end.');
  });

  it('m1 regression: a replacement containing "$&" is inserted literally, not interpreted as a regex substitution pattern', async () => {
    await docxCreateTool.execute(
      { path: 'dollar.docx', paragraphs: [{ text: 'Price: PLACEHOLDER.' }], overwrite: false },
      ctx(),
    );
    const result = await docxReplaceTextTool.execute(
      {
        path: 'dollar.docx',
        find: 'PLACEHOLDER',
        replace: 'Total: $& (was $1, now $$)',
        match_case: true,
      },
      ctx(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.replaced).toBe(1);

    const read = await docxReadTool.execute({ path: 'dollar.docx' }, ctx());
    if (!read.ok) throw new Error(read.reason);
    // A naive `run.text.replace(findRe, replace)` would have expanded "$&" to
    // the matched text ("PLACEHOLDER") and "$$" to a literal "$" via JS's
    // built-in $-substitution syntax. The literal string must survive as-is.
    expect(read.text).toContain('Price: Total: $& (was $1, now $$).');
  });

  it('m2 regression: a numeric XML character reference (&#233;) in a run round-trips instead of being re-escaped into literal "&amp;#233;"', async () => {
    const buf = await buildDocxWithNumericEntity();
    await writeFile(join(WORKSPACE, 'numeric-entity.docx'), buf);

    const result = await docxReplaceTextTool.execute(
      { path: 'numeric-entity.docx', find: 'TARGET', replace: 'DONE', match_case: true },
      ctx(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.replaced).toBe(1);

    const xml = await readDocumentXml('numeric-entity.docx');
    expect(xml).not.toContain('&amp;#233;');
    expect(xml).toContain('café DONE word');

    const read = await docxReadTool.execute({ path: 'numeric-entity.docx' }, ctx());
    if (!read.ok) throw new Error(read.reason);
    expect(read.text).toContain('café DONE word');
  });

  it('blocks path traversal', async () => {
    const result = await docxReplaceTextTool.execute(
      { path: '../escape.docx', find: 'x', replace: 'y', match_case: true },
      ctx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toMatch(/traversal|escape|workspace|outside/i);
  });
});
