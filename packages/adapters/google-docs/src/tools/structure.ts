// @nodalai/adapter-google-docs — structure tools
// docs_insert_paragraph, docs_insert_page_break, docs_insert_table, docs_insert_image

import { z } from 'zod';
import type { ToolDefinition } from '@nodalai/tools';
import type { docs_v1 } from 'googleapis';
import { mapDocsError, DocsAdapterError } from '../errors.js';
import {
  buildInsertParagraphRequest,
  buildInsertPageBreakRequest,
  buildInsertTableRequest,
  buildInsertImageRequest,
  buildApplyNamedStyleRequest,
} from '../helpers/batch-update.js';

// Named paragraph style types supported by Docs API
const NamedStyleType = z.enum([
  'NORMAL_TEXT',
  'TITLE',
  'SUBTITLE',
  'HEADING_1',
  'HEADING_2',
  'HEADING_3',
  'HEADING_4',
  'HEADING_5',
  'HEADING_6',
]);

// ── docs_insert_paragraph ──────────────────────────────────────────────────

const InsertParagraphInput = z.object({
  document_id: z
    .string()
    .describe('The Google Doc ID (from the URL: docs.google.com/document/d/{ID}/edit).'),
  text: z.string().describe('Paragraph text. A newline is appended automatically if not present.'),
  index: z
    .number()
    .int()
    .min(1)
    .describe(
      'Document body index at which to insert the paragraph. ' +
        'Index 1 = beginning of body. Use docs_get to find indices.',
    ),
  named_style: NamedStyleType.optional().describe(
    'Optional named paragraph style to apply after inserting (e.g. HEADING_1, NORMAL_TEXT).',
  ),
});

export type InsertParagraphOutput = {
  inserted: boolean;
  documentId: string;
  index: number;
};

export function createInsertParagraphTool(
  docs: docs_v1.Docs,
): ToolDefinition<typeof InsertParagraphInput, InsertParagraphOutput> {
  return {
    name: 'docs_insert_paragraph',
    description:
      'Insert a new paragraph at a specific index in a Google Document. ' +
      'Optionally apply a named paragraph style (HEADING_1…HEADING_6, TITLE, SUBTITLE, NORMAL_TEXT). ' +
      'A paragraph in Docs is defined by a trailing \\n — this is appended automatically.',
    inputSchema: InsertParagraphInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        const insertedText = input.text.endsWith('\n') ? input.text : input.text + '\n';
        const requests: docs_v1.Schema$Request[] = [
          buildInsertParagraphRequest(input.index, insertedText),
        ];

        // Apply named style if requested: the paragraph spans [index, index + textLen]
        if (input.named_style) {
          const textLen = insertedText.length;
          requests.push(
            buildApplyNamedStyleRequest(input.index, input.index + textLen, input.named_style),
          );
        }

        await docs.documents.batchUpdate({
          documentId: input.document_id,
          requestBody: { requests },
        });

        return { inserted: true, documentId: input.document_id, index: input.index };
      } catch (err) {
        if (err instanceof DocsAdapterError) throw err;
        throw mapDocsError(err);
      }
    },
  };
}

// ── docs_insert_page_break ─────────────────────────────────────────────────

const InsertPageBreakInput = z.object({
  document_id: z
    .string()
    .describe('The Google Doc ID (from the URL: docs.google.com/document/d/{ID}/edit).'),
  index: z.number().int().min(1).describe('Document body index at which to insert the page break.'),
});

export type InsertPageBreakOutput = {
  inserted: boolean;
  documentId: string;
  index: number;
};

export function createInsertPageBreakTool(
  docs: docs_v1.Docs,
): ToolDefinition<typeof InsertPageBreakInput, InsertPageBreakOutput> {
  return {
    name: 'docs_insert_page_break',
    description:
      'Insert a page break at a specific index in a Google Document. ' +
      'Useful for separating sections onto distinct pages.',
    inputSchema: InsertPageBreakInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        await docs.documents.batchUpdate({
          documentId: input.document_id,
          requestBody: {
            requests: [buildInsertPageBreakRequest(input.index)],
          },
        });
        return { inserted: true, documentId: input.document_id, index: input.index };
      } catch (err) {
        if (err instanceof DocsAdapterError) throw err;
        throw mapDocsError(err);
      }
    },
  };
}

// ── docs_insert_table ──────────────────────────────────────────────────────

const InsertTableInput = z.object({
  document_id: z
    .string()
    .describe('The Google Doc ID (from the URL: docs.google.com/document/d/{ID}/edit).'),
  index: z.number().int().min(1).describe('Document body index at which to insert the table.'),
  rows: z.number().int().min(1).max(100).describe('Number of rows in the table (1–100).'),
  columns: z.number().int().min(1).max(20).describe('Number of columns in the table (1–20).'),
});

export type InsertTableOutput = {
  inserted: boolean;
  documentId: string;
  rows: number;
  columns: number;
  index: number;
};

export function createInsertTableTool(
  docs: docs_v1.Docs,
): ToolDefinition<typeof InsertTableInput, InsertTableOutput> {
  return {
    name: 'docs_insert_table',
    description:
      'Insert a table with N rows × M columns at a specific index in a Google Document. ' +
      'After insertion, use docs_insert_text to populate individual cells.',
    inputSchema: InsertTableInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        await docs.documents.batchUpdate({
          documentId: input.document_id,
          requestBody: {
            requests: [buildInsertTableRequest(input.index, input.rows, input.columns)],
          },
        });
        return {
          inserted: true,
          documentId: input.document_id,
          rows: input.rows,
          columns: input.columns,
          index: input.index,
        };
      } catch (err) {
        if (err instanceof DocsAdapterError) throw err;
        throw mapDocsError(err);
      }
    },
  };
}

// ── docs_insert_image ──────────────────────────────────────────────────────

const InsertImageInput = z.object({
  document_id: z
    .string()
    .describe('The Google Doc ID (from the URL: docs.google.com/document/d/{ID}/edit).'),
  image_uri: z
    .string()
    .url()
    .describe('Public URL of the image to insert (must be publicly accessible).'),
  index: z.number().int().min(1).describe('Document body index at which to insert the image.'),
  width_pt: z
    .number()
    .positive()
    .optional()
    .describe('Optional image width in points (1pt ≈ 1.333px). Omit to use source dimensions.'),
  height_pt: z
    .number()
    .positive()
    .optional()
    .describe('Optional image height in points. Omit to use source dimensions.'),
});

export type InsertImageOutput = {
  inserted: boolean;
  documentId: string;
  index: number;
  imageUri: string;
};

export function createInsertImageTool(
  docs: docs_v1.Docs,
): ToolDefinition<typeof InsertImageInput, InsertImageOutput> {
  return {
    name: 'docs_insert_image',
    description:
      'Insert an inline image from a public URL at a specific index in a Google Document. ' +
      'Optionally specify width/height in points. The image URL must be publicly accessible.',
    inputSchema: InsertImageInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        await docs.documents.batchUpdate({
          documentId: input.document_id,
          requestBody: {
            requests: [
              buildInsertImageRequest(
                input.index,
                input.image_uri,
                input.width_pt,
                input.height_pt,
              ),
            ],
          },
        });
        return {
          inserted: true,
          documentId: input.document_id,
          index: input.index,
          imageUri: input.image_uri,
        };
      } catch (err) {
        if (err instanceof DocsAdapterError) throw err;
        throw mapDocsError(err);
      }
    },
  };
}
