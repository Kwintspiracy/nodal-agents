// office-ops/docx.ts — Word document tools
//
// Read: mammoth → plain text extraction (faithful, battle-tested). Table cell
//   text IS included (verified empirically: mammoth walks the whole body,
//   not just top-level paragraphs) — no separate table-extraction path needed.
// Create: docx library → build a fresh .docx from structured content blocks
//   (paragraphs incl. lists, tables, images, page breaks).
// Append: FIDELITY-PRESERVING in-place edit. word/document.xml is parsed as a
//   zip entry (jszip) and new <w:p> XML is spliced in directly before the
//   body's final <w:sectPr>, leaving every other byte of the archive —
//   styles, tables, images, headers/footers, the rest of the body — untouched.
// Replace: literal find/replace across word/document.xml, scoped per-<w:p>.
//
// All file access through readWorkspaceBinary / writeWorkspaceBinary.

import mammoth from 'mammoth';
import {
  Document,
  Paragraph,
  TextRun,
  ImageRun,
  Table,
  TableRow,
  TableCell,
  PageBreak,
  HeadingLevel,
  LevelFormat,
  Packer,
  AlignmentType,
  WidthType,
  convertInchesToTwip,
} from 'docx';
import JSZip from 'jszip';
import { z } from 'zod';
import type { ToolDefinition } from '../../types';
import { readWorkspaceBinary, writeWorkspaceBinary } from './office-helpers';

// ─── Shared helpers ────────────────────────────────────────────────────────────

const MAX_DOCX_TEXT_CHARS = 200_000; // ~200 KB of text — enough for most docs

const HEADING_MAP: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6,
};

// Style IDs docx-lib assigns its built-in heading styles (HeadingLevel.HEADING_N
// → styleId "HeadingN"). Referenced directly when writing raw <w:pStyle> XML in
// docx_append_paragraphs so an appended heading renders consistently with one
// produced by docx_create. If the target document lacks these style IDs, Word
// silently falls back to Normal for that paragraph — not a corruption risk.
const HEADING_STYLE_IDS: Record<number, string> = {
  1: 'Heading1',
  2: 'Heading2',
  3: 'Heading3',
  4: 'Heading4',
  5: 'Heading5',
  6: 'Heading6',
};

// Numbering reference used for docx_create's "numbered" list paragraphs. Only
// added to the generated Document when at least one paragraph requests it.
const NUMBERED_LIST_REFERENCE = 'nodal-numbered-list';
const MAX_LIST_LEVELS = 9; // levels 0-8

/** Build a docx Paragraph from the plan's paragraph descriptor shape (docx_create only). */
function buildParagraph(p: {
  text: string;
  heading?: number;
  bold?: boolean;
  italic?: boolean;
  list?: 'bullet' | 'numbered';
  list_level?: number;
}): Paragraph {
  const run = new TextRun({
    text: p.text,
    bold: p.bold ?? false,
    italics: p.italic ?? false,
  });

  const level = p.list_level ?? 0;

  return new Paragraph({
    children: [run],
    heading: p.heading ? HEADING_MAP[p.heading] : undefined,
    alignment: AlignmentType.LEFT,
    bullet: p.list === 'bullet' ? { level } : undefined,
    numbering: p.list === 'numbered' ? { reference: NUMBERED_LIST_REFERENCE, level } : undefined,
  });
}

/** Numbering config for docx_create's "numbered" list paragraphs (docx requires an explicit definition — unlike `bullet`, which docx-lib provides a built-in default for). */
function buildNumberingConfig() {
  return {
    config: [
      {
        reference: NUMBERED_LIST_REFERENCE,
        levels: Array.from({ length: MAX_LIST_LEVELS }, (_, level) => ({
          level,
          format: LevelFormat.DECIMAL,
          text: `%${level + 1}.`,
          alignment: AlignmentType.START,
          style: {
            paragraph: {
              indent: {
                left: convertInchesToTwip(0.5 * (level + 1)),
                hanging: convertInchesToTwip(0.25),
              },
            },
          },
        })),
      },
    ],
  };
}

// ─── Image dimension sniffing (PNG/JPEG) ──────────────────────────────────────
//
// No image-size dependency in the workspace (verified: not present anywhere in
// the monorepo). PNG and JPEG dimensions are both trivial to read directly from
// well-known header bytes, so that's done here instead of pulling in a new dep.
// If a buffer doesn't parse as either (corrupt file, unsupported format sneaking
// past the magic-byte check), a documented fixed fallback size is used rather
// than failing the whole docx_create call.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_IMAGE_WIDTH_PX = 600;
const FALLBACK_IMAGE_WIDTH_PX = 480;
const FALLBACK_IMAGE_HEIGHT_PX = 360; // documented 4:3 fallback when dimensions can't be parsed

function detectImageType(buf: Buffer): 'png' | 'jpg' | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  return null;
}

function readPngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null; // IHDR must be the first chunk
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/** Scans JPEG markers for the first Start-Of-Frame segment (SOF0-SOF15, excluding the DHT/DAC marker numbers), which carries the pixel dimensions. */
function readJpegDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null; // SOI
  let offset = 2;
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buf[offset + 1]!;
    if (marker === 0xff) {
      offset++; // padding fill byte
      continue;
    }
    // Markers with no length-prefixed payload: SOI/EOI/RST0-7/TEM
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (offset + 4 > buf.length) return null;
    const length = buf.readUInt16BE(offset + 2);
    const isSOF =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) {
      if (offset + 9 > buf.length) return null;
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      if (width <= 0 || height <= 0) return null;
      return { width, height };
    }
    offset += 2 + length;
  }
  return null;
}

function getScaledImageDimensions(
  buf: Buffer,
  type: 'png' | 'jpg',
): { width: number; height: number } {
  const raw = (type === 'png' ? readPngDimensions(buf) : readJpegDimensions(buf)) ?? {
    width: FALLBACK_IMAGE_WIDTH_PX,
    height: FALLBACK_IMAGE_HEIGHT_PX,
  };
  if (raw.width <= MAX_IMAGE_WIDTH_PX) return raw;
  const ratio = MAX_IMAGE_WIDTH_PX / raw.width;
  return { width: MAX_IMAGE_WIDTH_PX, height: Math.round(raw.height * ratio) };
}

// ─── XML escape/decode helpers (docx_append_paragraphs, docx_replace_text) ────

function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// &amp; is decoded LAST so an already-encoded entity like "&amp;lt;" (literal
// text "&lt;") round-trips instead of over-decoding into "<". Numeric
// character references (&#233; / &#xE9;) are decoded too — Word emits these
// for characters outside the editor's default entity set, and skipping them
// (as an earlier version of this function did) meant such a run got
// re-escaped into "&amp;#233;" on write, corrupting it. Mirrors pptx.ts's
// unescapeXmlText decode order.
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCharCode(Number(dec)))
    .replace(/&amp;/g, '&');
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── docx_read ────────────────────────────────────────────────────────────────

const DocxReadInput = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      'Workspace-relative path to the .docx file. For multi-workspace agents, prefix with the workspace label.',
    ),
});

type DocxReadOutput =
  | { ok: true; text: string; paragraphs: string[]; truncated: boolean }
  | { ok: false; reason: string };

export const docxReadTool: ToolDefinition<typeof DocxReadInput, DocxReadOutput> = {
  name: 'docx_read',
  description:
    'Read the text content of a Word (.docx) document from the agent workspace. ' +
    'Returns the full plain text and a paragraph-per-line array. Table cell text IS ' +
    'included (mammoth walks the whole document body). Images and headers/footers are not included.',
  inputSchema: DocxReadInput,
  riskLevel: 'read',
  execute: async (input, ctx) => {
    const readResult = await readWorkspaceBinary(ctx, input.path);
    if (!readResult.ok) return readResult;

    const result = await mammoth.extractRawText({ buffer: readResult.buffer });
    let text = result.value;
    const truncated = text.length > MAX_DOCX_TEXT_CHARS;
    if (truncated) {
      text = text.slice(0, MAX_DOCX_TEXT_CHARS) + '\n[truncated]';
    }

    const paragraphs = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    return { ok: true, text, paragraphs, truncated };
  },
};

// ─── docx_create ─────────────────────────────────────────────────────────────

const CreateParagraphBlockSchema = z.object({
  text: z.string().describe('Paragraph text content.'),
  heading: z
    .number()
    .int()
    .min(1)
    .max(6)
    .optional()
    .describe('Heading level (1-6). Omit for normal paragraph.'),
  bold: z.boolean().optional().describe('Bold text.'),
  italic: z.boolean().optional().describe('Italic text.'),
  list: z
    .enum(['bullet', 'numbered'])
    .optional()
    .describe(
      'Render this paragraph as a list item: "bullet" (unordered) or "numbered" (auto-numbered, ordered).',
    ),
  list_level: z
    .number()
    .int()
    .min(0)
    .max(8)
    .optional()
    .describe(
      'Indent level for the list item (0 = top level). Only meaningful when `list` is set.',
    ),
});

const TableBlockSchema = z.object({
  table: z.object({
    rows: z
      .array(z.array(z.string()))
      .min(1)
      .describe(
        'Table rows, each an array of cell text. All rows should share the same column count.',
      ),
    header: z
      .boolean()
      .optional()
      .describe('If true, the first row is styled as a bold header row.'),
  }),
});

const ImageBlockSchema = z.object({
  image_path: z
    .string()
    .min(1)
    .describe(
      'Workspace-relative path to a PNG or JPEG image to embed. Resolved through the workspace ' +
        `security guard. Scaled down to fit a max width of ${MAX_IMAGE_WIDTH_PX}px, aspect ratio preserved.`,
    ),
});

const PageBreakBlockSchema = z.object({
  page_break: z.literal(true).describe('Insert a page break at this point.'),
});

const ContentBlockSchema = z.union([
  CreateParagraphBlockSchema,
  TableBlockSchema,
  ImageBlockSchema,
  PageBreakBlockSchema,
]);

const DocxCreateInput = z.object({
  path: z
    .string()
    .min(1)
    .describe('Workspace-relative path for the new .docx file (e.g. "docs/report.docx").'),
  paragraphs: z
    .array(ContentBlockSchema)
    .describe(
      'Content blocks to include, in order. Each is either a paragraph (text + optional heading/' +
        'bold/italic/list), a table ({ table: { rows, header? } }), an image ({ image_path }), or a ' +
        'page break ({ page_break: true }).',
    ),
  overwrite: z
    .boolean()
    .optional()
    .default(false)
    .describe('If false (default) refuse to overwrite an existing file.'),
});

type DocxCreateOutput = { ok: true; path: string } | { ok: false; reason: string };

export const docxCreateTool: ToolDefinition<typeof DocxCreateInput, DocxCreateOutput> = {
  name: 'docx_create',
  description:
    'Create a new Word (.docx) document from an ordered list of content blocks: paragraphs ' +
    '(with heading level 1-6, bold, italic, and bullet/numbered lists), tables, images (PNG/JPEG), ' +
    'and page breaks. Fails if the file already exists unless overwrite:true is passed.',
  inputSchema: DocxCreateInput,
  riskLevel: 'write',
  execute: async (input, ctx) => {
    let usesNumberedList = false;
    const children: (Paragraph | Table)[] = [];

    for (const block of input.paragraphs) {
      if ('table' in block) {
        const { rows, header } = block.table;
        children.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: rows.map(
              (row, rowIndex) =>
                new TableRow({
                  children: row.map(
                    (cellText) =>
                      new TableCell({
                        children: [
                          new Paragraph({
                            children: [
                              new TextRun({ text: cellText, bold: !!header && rowIndex === 0 }),
                            ],
                          }),
                        ],
                      }),
                  ),
                }),
            ),
          }),
        );
      } else if ('image_path' in block) {
        const readResult = await readWorkspaceBinary(ctx, block.image_path);
        if (!readResult.ok) return { ok: false, reason: `image_path error: ${readResult.reason}` };
        const imgType = detectImageType(readResult.buffer);
        if (!imgType) {
          return {
            ok: false,
            reason: `image_path "${block.image_path}" is not a recognized PNG or JPEG file (checked magic bytes).`,
          };
        }
        const { width, height } = getScaledImageDimensions(readResult.buffer, imgType);
        children.push(
          new Paragraph({
            children: [
              new ImageRun({
                type: imgType,
                data: readResult.buffer,
                transformation: { width, height },
              }),
            ],
          }),
        );
      } else if ('page_break' in block) {
        children.push(new Paragraph({ children: [new PageBreak()] }));
      } else {
        if (block.list === 'numbered') usesNumberedList = true;
        children.push(buildParagraph(block));
      }
    }

    const doc = new Document({
      numbering: usesNumberedList ? buildNumberingConfig() : undefined,
      sections: [{ children }],
    });

    const buffer = Buffer.from(await Packer.toBuffer(doc));
    const writeResult = await writeWorkspaceBinary(ctx, input.path, buffer, {
      overwrite: input.overwrite,
    });
    if (!writeResult.ok) return writeResult;
    return { ok: true, path: writeResult.path };
  },
};

// ─── docx_append_paragraphs ───────────────────────────────────────────────────

// Same shape docx_create's paragraphs used before lists were added — lists are
// deliberately NOT supported here: rendering a numbered list requires a
// numbering.xml part + relationship that may not exist (or may collide with
// one already present) in an arbitrary target document, which is exactly the
// kind of half-correct merge this tool must not attempt silently. Fails loud
// instead (see execute() below) rather than silently dropping the list.
// .strict(): an agent that carries `list`/`list_level` over from a docx_create
// call must get a loud schema-validation error, not have those fields silently
// stripped (zod's default for unrecognized object keys) and the list silently
// dropped — see the destructive-formatting invariant this file follows throughout.
const AppendParagraphSchema = z
  .object({
    text: z.string().describe('Paragraph text content.'),
    heading: z
      .number()
      .int()
      .min(1)
      .max(6)
      .optional()
      .describe("Heading level (1-6), rendered via the target document's Heading1-6 style IDs."),
    bold: z.boolean().optional().describe('Bold text.'),
    italic: z.boolean().optional().describe('Italic text.'),
  })
  .strict();

const DocxAppendInput = z.object({
  path: z
    .string()
    .min(1)
    .describe('Workspace-relative path to the existing .docx file to append to.'),
  paragraphs: z
    .array(AppendParagraphSchema)
    .min(1)
    .describe('New paragraphs to append after the existing content.'),
});

type DocxAppendOutput =
  | { ok: true; path: string; paragraphs_appended: number }
  | { ok: false; reason: string };

/** Builds a single raw <w:p> element for splicing into an existing document.xml. */
function buildParagraphXml(p: {
  text: string;
  heading?: number;
  bold?: boolean;
  italic?: boolean;
}): string {
  const pPr = p.heading ? `<w:pPr><w:pStyle w:val="${HEADING_STYLE_IDS[p.heading]}"/></w:pPr>` : '';
  const rPrParts: string[] = [];
  if (p.bold) rPrParts.push('<w:b/>');
  if (p.italic) rPrParts.push('<w:i/>');
  const rPr = rPrParts.length > 0 ? `<w:rPr>${rPrParts.join('')}</w:rPr>` : '';
  const text = escapeXmlText(p.text);
  return `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

// Matches the body's FINAL <w:sectPr> — the one that is a direct child of
// <w:body>, always its last child per the OOXML schema — by requiring it be
// immediately (whitespace aside) followed by </w:body>.
//
// C1 FIX: an earlier version of this regex had NO greedy prefix, i.e. started
// matching directly at `<w:sectPr`. On a multi-section document that's a bug:
// regex engines try the LEFTMOST starting position first, so the match
// attempt begins at the FIRST <w:sectPr> in the document — typically one
// nested inside an EARLIER paragraph's <w:pPr> for a section break. That
// specific attempt's lazy `[\s\S]*?` doesn't stop at that sectPr's own
// `</w:sectPr>` (immediately followed by more body content, not `</w:body>`,
// so the overall match fails there) — it BACKTRACKS by extending itself
// further into the document until it reaches a `</w:sectPr>` that IS
// followed by `</w:body>` (the true final one). The result: a single "match"
// spanning from the FIRST sectPr's opening tag all the way to the LAST
// sectPr's closing tag, captured as if it were one block — and the new
// paragraphs got spliced in front of it, landing INSIDE the first
// paragraph's <w:pPr>, producing invalid OOXML that Word refuses to open.
//
// Fix: force the match to start at the LAST <w:sectPr> via a GREEDY prefix
// group. `[\s\S]*` (greedy) first consumes the entire rest of the string,
// then backtracks the minimum amount needed for the rest of the pattern to
// match — which lands it on the rightmost possible `<w:sectPr` position.
// Since `</w:body>` is unique and only the TRUE final sectPr is immediately
// followed by (whitespace then) `</w:body>`, this can only succeed at the
// real insertion point, regardless of how many earlier section-break sectPr
// elements exist.
const FINAL_SECTPR_RE =
  /^([\s\S]*)(<w:sectPr\b(?:[^>]*\/>|[^>]*>[\s\S]*?<\/w:sectPr>))(\s*<\/w:body>)/;

export const docxAppendParagraphsTool: ToolDefinition<typeof DocxAppendInput, DocxAppendOutput> = {
  name: 'docx_append_paragraphs',
  description:
    'Append paragraphs (with optional heading 1-6, bold, italic) to the END of an existing Word ' +
    '(.docx) document, in place. Fidelity-preserving: the new <w:p> XML is inserted directly into ' +
    'word/document.xml before the closing section properties — everything else in the document ' +
    '(styles, tables, images, headers/footers, existing formatting) is left byte-for-byte untouched. ' +
    'Lists are not supported here — use docx_create for a new document with lists.',
  inputSchema: DocxAppendInput,
  // Downgraded from destructive/require_approval: the previous implementation
  // rebuilt the whole document from a plain-text extraction, discarding all
  // existing formatting — genuinely destructive. This version only ADDS new
  // <w:p> nodes and never touches or removes anything else in the archive, so
  // it's a plain write, same posture as xlsx_append_rows.
  riskLevel: 'write',
  execute: async (input, ctx) => {
    const readResult = await readWorkspaceBinary(ctx, input.path);
    if (!readResult.ok) return readResult;

    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(readResult.buffer);
    } catch (err) {
      return {
        ok: false,
        reason: `Corrupt or unreadable .docx (zip) data: ${(err as Error).message}`,
      };
    }

    const documentXmlFile = zip.file('word/document.xml');
    if (!documentXmlFile) {
      return { ok: false, reason: 'Invalid .docx: missing word/document.xml.' };
    }
    const xml = await documentXmlFile.async('string');

    if (!/<w:body\b/.test(xml)) {
      return { ok: false, reason: 'Unexpected document.xml structure: no <w:body> element found.' };
    }

    if (!FINAL_SECTPR_RE.test(xml)) {
      return {
        ok: false,
        reason:
          'Unexpected document.xml structure: could not locate the final section properties ' +
          '(<w:sectPr>) immediately before </w:body>. Refusing to guess an insertion point.',
      };
    }

    const paragraphsXml = input.paragraphs.map((p) => buildParagraphXml(p)).join('');
    const newXml = xml.replace(
      FINAL_SECTPR_RE,
      (_full, prefix: string, sectPr: string, tail: string) => {
        return `${prefix}${paragraphsXml}${sectPr}${tail}`;
      },
    );

    zip.file('word/document.xml', newXml);
    const outBuffer = Buffer.from(
      await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
    );

    // overwrite:true — we always replace the source file after mutation
    const writeResult = await writeWorkspaceBinary(ctx, input.path, outBuffer, { overwrite: true });
    if (!writeResult.ok) return writeResult;
    return { ok: true, path: writeResult.path, paragraphs_appended: input.paragraphs.length };
  },
};

// ─── docx_replace_text ─────────────────────────────────────────────────────────

const DocxReplaceTextInput = z.object({
  path: z.string().min(1).describe('Workspace-relative path to the existing .docx file to edit.'),
  find: z.string().min(1).describe('Literal text to search for (no regex; matched literally).'),
  replace: z.string().describe('Replacement text.'),
  match_case: z.boolean().optional().default(true).describe('Case-sensitive match. Default true.'),
});

type DocxReplaceTextOutput =
  | { ok: true; path: string; replaced: number; skipped_fragmented: number }
  | { ok: false; reason: string };

function countLiteralOccurrences(haystack: string, needleRe: RegExp): number {
  return (haystack.match(needleRe) || []).length;
}

/**
 * v1 honest replace strategy: a run of text in Word may be fragmented across
 * multiple <w:t> elements (spell-check squiggles, tracked-change boundaries,
 * font switches mid-word all split runs). Only occurrences fully contained in
 * a SINGLE <w:t> are actually replaced — the majority case for text typed as
 * one continuous string. Occurrences that only appear once the paragraph's
 * <w:t> texts are concatenated (i.e. split across runs) are counted as
 * "skipped_fragmented" and reported, never silently dropped or guessed at.
 */
function replaceInParagraphXml(
  pBlock: string,
  find: string,
  replace: string,
  matchCase: boolean,
): { newBlock: string; replaced: number; fragmented: number } {
  const runRe = /<w:t\b([^>]*)>([\s\S]*?)<\/w:t>/g;
  const runs: { index: number; length: number; attrs: string; text: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = runRe.exec(pBlock)) !== null) {
    runs.push({
      index: m.index,
      length: m[0].length,
      attrs: m[1] ?? '',
      text: decodeXmlEntities(m[2] ?? ''),
    });
  }
  if (runs.length === 0) return { newBlock: pBlock, replaced: 0, fragmented: 0 };

  const flags = matchCase ? 'g' : 'gi';
  const findRe = new RegExp(escapeForRegExp(find), flags);

  const concatenated = runs.map((r) => r.text).join('');
  const concatCount = countLiteralOccurrences(concatenated, findRe);
  if (concatCount === 0) return { newBlock: pBlock, replaced: 0, fragmented: 0 };

  let replacedTotal = 0;
  let cursor = 0;
  let newBlock = '';
  for (const run of runs) {
    newBlock += pBlock.slice(cursor, run.index);
    const runCount = countLiteralOccurrences(run.text, findRe);
    if (runCount > 0) {
      replacedTotal += runCount;
      // Replacement callback, not the string form: `replace` is user-supplied
      // literal text that must never be interpreted as a $-substitution
      // pattern ($&, $1, $$, ...) by String.prototype.replace.
      const newText = run.text.replace(findRe, () => replace);
      newBlock += `<w:t${run.attrs}>${escapeXmlText(newText)}</w:t>`;
    } else {
      newBlock += pBlock.slice(run.index, run.index + run.length);
    }
    cursor = run.index + run.length;
  }
  newBlock += pBlock.slice(cursor);

  const fragmented = Math.max(0, concatCount - replacedTotal);
  return { newBlock, replaced: replacedTotal, fragmented };
}

function replaceInDocumentXml(
  xml: string,
  find: string,
  replace: string,
  matchCase: boolean,
): { xml: string; replaced: number; fragmented: number } {
  // <w:p> never nests (tables hold their own non-nested <w:p> inside cells),
  // so a non-greedy scan for open/close pairs correctly isolates each paragraph.
  const pRe = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
  let m: RegExpExecArray | null;
  let cursor = 0;
  let result = '';
  let totalReplaced = 0;
  let totalFragmented = 0;
  while ((m = pRe.exec(xml)) !== null) {
    result += xml.slice(cursor, m.index);
    const { newBlock, replaced, fragmented } = replaceInParagraphXml(
      m[0],
      find,
      replace,
      matchCase,
    );
    result += newBlock;
    totalReplaced += replaced;
    totalFragmented += fragmented;
    cursor = m.index + m[0].length;
  }
  result += xml.slice(cursor);
  return { xml: result, replaced: totalReplaced, fragmented: totalFragmented };
}

export const docxReplaceTextTool: ToolDefinition<
  typeof DocxReplaceTextInput,
  DocxReplaceTextOutput
> = {
  name: 'docx_replace_text',
  description:
    "Find and replace literal text (no regex) inside an existing Word (.docx) document's body " +
    'in place, preserving all formatting. Only text fully contained in a single formatting run is ' +
    'replaced — occurrences split across multiple runs (e.g. spell-check or tracked-change ' +
    'boundaries mid-word) are detected but not modified and are reported in `skipped_fragmented`. ' +
    'Headers/footers are not covered. Fails loud if the text is not found at all.',
  inputSchema: DocxReplaceTextInput,
  riskLevel: 'write',
  execute: async (input, ctx) => {
    const readResult = await readWorkspaceBinary(ctx, input.path);
    if (!readResult.ok) return readResult;

    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(readResult.buffer);
    } catch (err) {
      return {
        ok: false,
        reason: `Corrupt or unreadable .docx (zip) data: ${(err as Error).message}`,
      };
    }

    const documentXmlFile = zip.file('word/document.xml');
    if (!documentXmlFile) {
      return { ok: false, reason: 'Invalid .docx: missing word/document.xml.' };
    }
    const xml = await documentXmlFile.async('string');

    const {
      xml: newXml,
      replaced,
      fragmented,
    } = replaceInDocumentXml(xml, input.find, input.replace, input.match_case);

    if (replaced === 0 && fragmented === 0) {
      return { ok: false, reason: `Text "${input.find}" was not found in "${input.path}".` };
    }

    if (replaced === 0) {
      // Nothing was actually written — every occurrence is fragmented across
      // runs. Still fail loud: the caller asked for a replace and got none.
      return {
        ok: false,
        reason:
          `Text "${input.find}" was found ${fragmented} time(s) but only as fragments split across ` +
          'multiple formatting runs — none could be safely replaced. No changes were made.',
      };
    }

    zip.file('word/document.xml', newXml);
    const outBuffer = Buffer.from(
      await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
    );

    const writeResult = await writeWorkspaceBinary(ctx, input.path, outBuffer, { overwrite: true });
    if (!writeResult.ok) return writeResult;
    return { ok: true, path: writeResult.path, replaced, skipped_fragmented: fragmented };
  },
};
