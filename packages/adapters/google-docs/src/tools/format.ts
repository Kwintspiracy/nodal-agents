// @nodalai/adapter-google-docs — formatting tools
// docs_format_text, docs_apply_named_style, docs_batch_update

import { z } from 'zod';
import type { ToolDefinition } from '@nodalai/tools';
import type { docs_v1 } from 'googleapis';
import { mapDocsError, DocsAdapterError } from '../errors';
import { buildUpdateTextStyleRequest, buildApplyNamedStyleRequest } from '../helpers/batch-update';

// Named paragraph style types
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

// ── docs_format_text ───────────────────────────────────────────────────────

const FormatTextInput = z.object({
  document_id: z
    .string()
    .describe('The Google Doc ID (from the URL: docs.google.com/document/d/{ID}/edit).'),
  start_index: z
    .number()
    .int()
    .min(1)
    .describe('Start of the text range to format (inclusive). Get indices from docs_get.'),
  end_index: z.number().int().min(2).describe('End of the text range to format (exclusive).'),
  bold: z.boolean().optional().describe('Apply bold formatting.'),
  italic: z.boolean().optional().describe('Apply italic formatting.'),
  underline: z.boolean().optional().describe('Apply underline formatting.'),
  strikethrough: z.boolean().optional().describe('Apply strikethrough formatting.'),
  font_size_pt: z.number().positive().optional().describe('Font size in points (e.g. 12, 14, 18).'),
  foreground_color: z
    .object({
      red: z.number().min(0).max(1).describe('Red channel 0–1.'),
      green: z.number().min(0).max(1).describe('Green channel 0–1.'),
      blue: z.number().min(0).max(1).describe('Blue channel 0–1.'),
    })
    .optional()
    .describe('Text foreground color (RGB, each channel 0–1).'),
  font_family: z
    .string()
    .optional()
    .describe('Font family name (e.g. "Arial", "Times New Roman", "Roboto").'),
});

export type FormatTextOutput = {
  formatted: boolean;
  documentId: string;
  startIndex: number;
  endIndex: number;
};

export function createFormatTextTool(
  docs: docs_v1.Docs,
): ToolDefinition<typeof FormatTextInput, FormatTextOutput> {
  return {
    name: 'docs_format_text',
    description:
      'Apply character-level formatting to a text range in a Google Document: ' +
      'bold, italic, underline, strikethrough, font size, foreground color, and font family. ' +
      'Use docs_get to find the start/end indices of the text to format.',
    inputSchema: FormatTextInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        if (input.end_index <= input.start_index) {
          throw new DocsAdapterError(
            'docs_invalid_request',
            `end_index (${input.end_index}) must be greater than start_index (${input.start_index}).`,
          );
        }

        const textStyle: docs_v1.Schema$TextStyle = {};
        const fields: string[] = [];

        if (input.bold !== undefined) {
          textStyle.bold = input.bold;
          fields.push('bold');
        }
        if (input.italic !== undefined) {
          textStyle.italic = input.italic;
          fields.push('italic');
        }
        if (input.underline !== undefined) {
          textStyle.underline = input.underline;
          fields.push('underline');
        }
        if (input.strikethrough !== undefined) {
          textStyle.strikethrough = input.strikethrough;
          fields.push('strikethrough');
        }
        if (input.font_size_pt !== undefined) {
          textStyle.fontSize = { magnitude: input.font_size_pt, unit: 'PT' };
          fields.push('fontSize');
        }
        if (input.foreground_color !== undefined) {
          textStyle.foregroundColor = {
            color: {
              rgbColor: {
                red: input.foreground_color.red,
                green: input.foreground_color.green,
                blue: input.foreground_color.blue,
              },
            },
          };
          fields.push('foregroundColor');
        }
        if (input.font_family !== undefined) {
          textStyle.weightedFontFamily = { fontFamily: input.font_family };
          fields.push('weightedFontFamily');
        }

        if (fields.length === 0) {
          throw new DocsAdapterError(
            'docs_invalid_request',
            'Provide at least one formatting property (bold, italic, underline, font_size_pt, etc.).',
          );
        }

        await docs.documents.batchUpdate({
          documentId: input.document_id,
          requestBody: {
            requests: [
              buildUpdateTextStyleRequest(
                input.start_index,
                input.end_index,
                textStyle,
                fields.join(','),
              ),
            ],
          },
        });

        return {
          formatted: true,
          documentId: input.document_id,
          startIndex: input.start_index,
          endIndex: input.end_index,
        };
      } catch (err) {
        if (err instanceof DocsAdapterError) throw err;
        throw mapDocsError(err);
      }
    },
  };
}

// ── docs_apply_named_style ─────────────────────────────────────────────────

const ApplyNamedStyleInput = z.object({
  document_id: z
    .string()
    .describe('The Google Doc ID (from the URL: docs.google.com/document/d/{ID}/edit).'),
  start_index: z
    .number()
    .int()
    .min(1)
    .describe('Start of the paragraph range (inclusive). Get indices from docs_get.'),
  end_index: z.number().int().min(2).describe('End of the paragraph range (exclusive).'),
  named_style: NamedStyleType.describe(
    'The paragraph style to apply: NORMAL_TEXT, TITLE, SUBTITLE, HEADING_1 through HEADING_6.',
  ),
});

export type ApplyNamedStyleOutput = {
  applied: boolean;
  documentId: string;
  startIndex: number;
  endIndex: number;
  namedStyle: string;
};

export function createApplyNamedStyleTool(
  docs: docs_v1.Docs,
): ToolDefinition<typeof ApplyNamedStyleInput, ApplyNamedStyleOutput> {
  return {
    name: 'docs_apply_named_style',
    description:
      'Apply a named paragraph style to a range in a Google Document: ' +
      'HEADING_1 through HEADING_6, TITLE, SUBTITLE, or NORMAL_TEXT. ' +
      'Use docs_get to find the paragraph start/end indices.',
    inputSchema: ApplyNamedStyleInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        if (input.end_index <= input.start_index) {
          throw new DocsAdapterError(
            'docs_invalid_request',
            `end_index (${input.end_index}) must be greater than start_index (${input.start_index}).`,
          );
        }

        await docs.documents.batchUpdate({
          documentId: input.document_id,
          requestBody: {
            requests: [
              buildApplyNamedStyleRequest(input.start_index, input.end_index, input.named_style),
            ],
          },
        });

        return {
          applied: true,
          documentId: input.document_id,
          startIndex: input.start_index,
          endIndex: input.end_index,
          namedStyle: input.named_style,
        };
      } catch (err) {
        if (err instanceof DocsAdapterError) throw err;
        throw mapDocsError(err);
      }
    },
  };
}

// ── docs_batch_update ──────────────────────────────────────────────────────
// Escape hatch: accepts raw Docs API Request objects for advanced agents.
// We accept a z.array(z.record(z.unknown())) — fully open to all request shapes,
// since the Docs API Request union has ~40+ variants and exhaustive Zod typing would
// be counterproductive. Validation is delegated to the Docs API itself.

const BatchUpdateInput = z.object({
  document_id: z
    .string()
    .describe('The Google Doc ID (from the URL: docs.google.com/document/d/{ID}/edit).'),
  requests: z
    .array(z.record(z.unknown()))
    .min(1)
    .describe(
      'Array of Google Docs API Request objects. ' +
        'Each object must have exactly one key matching a Docs API operation ' +
        '(e.g. insertText, deleteContentRange, updateParagraphStyle, replaceAllText, etc.). ' +
        'See https://developers.google.com/docs/api/reference/rest/v1/documents/request for the full schema.',
    ),
});

export type BatchUpdateOutput = {
  documentId: string;
  repliesCount: number;
  writeControl: docs_v1.Schema$WriteControl | undefined;
};

export function createBatchUpdateTool(
  docs: docs_v1.Docs,
): ToolDefinition<typeof BatchUpdateInput, BatchUpdateOutput> {
  return {
    name: 'docs_batch_update',
    description:
      'Execute multiple Google Docs API update requests in a single call (escape hatch for advanced agents). ' +
      'Accepts any valid Docs API Request objects — insertText, deleteContentRange, updateTextStyle, ' +
      'updateParagraphStyle, replaceAllText, insertTable, insertInlineImage, and more. ' +
      'All requests are applied atomically in order. Use this when other docs_* tools do not cover your use case.',
    inputSchema: BatchUpdateInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        const res = await docs.documents.batchUpdate({
          documentId: input.document_id,
          requestBody: {
            requests: input.requests as docs_v1.Schema$Request[],
          },
        });
        return {
          documentId: input.document_id,
          repliesCount: res.data.replies?.length ?? 0,
          writeControl: res.data.writeControl ?? undefined,
        };
      } catch (err) {
        if (err instanceof DocsAdapterError) throw err;
        throw mapDocsError(err);
      }
    },
  };
}
