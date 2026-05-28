// office-ops/docx.ts — Word document tools
//
// Read: mammoth → plain text extraction (faithful, battle-tested).
// Create: docx library → build a fresh .docx from structured paragraphs.
// Append: read current text via mammoth then REBUILD the document with docx —
//   note the fidelity limitation: the original formatting (fonts, tables, images,
//   headers/footers) is LOST on rebuild; only the text paragraphs survive.
//   This limitation is documented in the skill content so agents know to warn
//   users. True in-place edit of existing Word files is not supported in V1.
//
// All file access through readWorkspaceBinary / writeWorkspaceBinary.

import mammoth from 'mammoth';
import { Document, Paragraph, TextRun, HeadingLevel, Packer, AlignmentType } from 'docx';
import { z } from 'zod';
import type { ToolDefinition } from '../../types';
import { readWorkspaceBinary, writeWorkspaceBinary } from './office-helpers';

// ─── Shared helpers ────────────────────────────────────────────────────────────

const MAX_DOCX_TEXT_CHARS = 200_000; // ~200 KB of text — enough for most docs

/** Build a docx Paragraph from the plan's paragraph descriptor shape. */
function buildParagraph(p: {
  text: string;
  heading?: number;
  bold?: boolean;
  italic?: boolean;
}): Paragraph {
  const run = new TextRun({
    text: p.text,
    bold: p.bold ?? false,
    italics: p.italic ?? false,
  });

  const headingMap: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
    1: HeadingLevel.HEADING_1,
    2: HeadingLevel.HEADING_2,
    3: HeadingLevel.HEADING_3,
    4: HeadingLevel.HEADING_4,
    5: HeadingLevel.HEADING_5,
    6: HeadingLevel.HEADING_6,
  };

  return new Paragraph({
    children: [run],
    heading: p.heading ? headingMap[p.heading] : undefined,
    alignment: AlignmentType.LEFT,
  });
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
    'Returns the full plain text and a paragraph-per-line array. ' +
    'Tables, images, and headers/footers are not included in text extraction.',
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

const ParagraphSchema = z.object({
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
});

const DocxCreateInput = z.object({
  path: z
    .string()
    .min(1)
    .describe('Workspace-relative path for the new .docx file (e.g. "docs/report.docx").'),
  paragraphs: z.array(ParagraphSchema).describe('Paragraphs to include in the document, in order.'),
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
    'Create a new Word (.docx) document from a list of paragraphs. Each paragraph can ' +
    'have a heading level (1-6), bold, and italic styling. ' +
    'Fails if the file already exists unless overwrite:true is passed.',
  inputSchema: DocxCreateInput,
  riskLevel: 'write',
  execute: async (input, ctx) => {
    const doc = new Document({
      sections: [
        {
          children: input.paragraphs.map((p) => buildParagraph(p)),
        },
      ],
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

const DocxAppendInput = z.object({
  path: z
    .string()
    .min(1)
    .describe('Workspace-relative path to the existing .docx file to append to.'),
  paragraphs: z
    .array(ParagraphSchema)
    .describe('New paragraphs to append after the existing content.'),
});

type DocxAppendOutput =
  | { ok: true; path: string; paragraphs_appended: number }
  | { ok: false; reason: string };

export const docxAppendParagraphsTool: ToolDefinition<typeof DocxAppendInput, DocxAppendOutput> = {
  name: 'docx_append_paragraphs',
  description:
    'Append paragraphs to an existing Word (.docx) document. ' +
    '⚠ FIDELITY LIMIT: the original document is first read as plain text via mammoth, ' +
    'then REBUILT with the new paragraphs appended. Original formatting (fonts, tables, ' +
    'images, headers/footers, styles) is LOST in the rebuild. For best results, use ' +
    'docx_create to produce fully-formatted documents and docx_append_paragraphs only ' +
    'when plain-text continuity is sufficient.',
  inputSchema: DocxAppendInput,
  riskLevel: 'write',
  execute: async (input, ctx) => {
    const readResult = await readWorkspaceBinary(ctx, input.path);
    if (!readResult.ok) return readResult;

    // Extract existing text via mammoth
    const extracted = await mammoth.extractRawText({ buffer: readResult.buffer });
    const existingLines = extracted.value
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    // Rebuild: existing lines as plain paragraphs + new paragraphs
    const existingParagraphs = existingLines.map((text) => buildParagraph({ text }));
    const newParagraphs = input.paragraphs.map((p) => buildParagraph(p));

    const doc = new Document({
      sections: [
        {
          children: [...existingParagraphs, ...newParagraphs],
        },
      ],
    });

    const buffer = Buffer.from(await Packer.toBuffer(doc));
    // overwrite:true — we always replace the source file after mutation
    const writeResult = await writeWorkspaceBinary(ctx, input.path, buffer, { overwrite: true });
    if (!writeResult.ok) return writeResult;
    return { ok: true, path: writeResult.path, paragraphs_appended: input.paragraphs.length };
  },
};
