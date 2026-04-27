// @nodalai/adapter-google-docs — text content tools
// docs_insert_text, docs_append_text, docs_replace_text, docs_delete_content_range

import { z } from 'zod';
import type { ToolDefinition } from '@nodalai/tools';
import type { docs_v1 } from 'googleapis';
import { mapDocsError, DocsAdapterError } from '../errors.js';
import {
  buildInsertTextRequest,
  buildAppendTextRequest,
  buildReplaceAllTextRequest,
  buildDeleteContentRangeRequest,
} from '../helpers/batch-update.js';

// ── docs_insert_text ───────────────────────────────────────────────────────

const InsertTextInput = z.object({
  document_id: z
    .string()
    .describe('The Google Doc ID (from the URL: docs.google.com/document/d/{ID}/edit).'),
  text: z.string().describe('Text to insert.'),
  index: z
    .number()
    .int()
    .min(1)
    .describe(
      'Document body index at which to insert text. Index 1 = beginning of body. ' +
        'Use docs_get to inspect element indices. Insertions shift all subsequent content.',
    ),
});

export type InsertTextOutput = {
  inserted: boolean;
  documentId: string;
  index: number;
  charCount: number;
};

export function createInsertTextTool(
  docs: docs_v1.Docs,
): ToolDefinition<typeof InsertTextInput, InsertTextOutput> {
  return {
    name: 'docs_insert_text',
    description:
      'Insert text at a specific index in a Google Document body. ' +
      'Index 1 = start of body. Use docs_get to find element indices. ' +
      'This shifts all subsequent content forward.',
    inputSchema: InsertTextInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        await docs.documents.batchUpdate({
          documentId: input.document_id,
          requestBody: {
            requests: [buildInsertTextRequest(input.text, input.index)],
          },
        });
        return {
          inserted: true,
          documentId: input.document_id,
          index: input.index,
          charCount: input.text.length,
        };
      } catch (err) {
        if (err instanceof DocsAdapterError) throw err;
        throw mapDocsError(err);
      }
    },
  };
}

// ── docs_append_text ───────────────────────────────────────────────────────

const AppendTextInput = z.object({
  document_id: z
    .string()
    .describe('The Google Doc ID (from the URL: docs.google.com/document/d/{ID}/edit).'),
  text: z.string().describe('Text to append at the end of the document. Use \\n for line breaks.'),
});

export type AppendTextOutput = {
  appended: boolean;
  documentId: string;
  charCount: number;
};

export function createAppendTextTool(
  docs: docs_v1.Docs,
): ToolDefinition<typeof AppendTextInput, AppendTextOutput> {
  return {
    name: 'docs_append_text',
    description:
      'Append text to the end of a Google Document. ' +
      'Uses endOfSegmentLocation — always inserts at the very end of the body, ' +
      'regardless of the current document length. Use \\n for line breaks.',
    inputSchema: AppendTextInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        const text = input.text.endsWith('\n') ? input.text : input.text + '\n';
        await docs.documents.batchUpdate({
          documentId: input.document_id,
          requestBody: {
            requests: [buildAppendTextRequest(text)],
          },
        });
        return {
          appended: true,
          documentId: input.document_id,
          charCount: text.length,
        };
      } catch (err) {
        if (err instanceof DocsAdapterError) throw err;
        throw mapDocsError(err);
      }
    },
  };
}

// ── docs_replace_text ──────────────────────────────────────────────────────

const ReplaceTextInput = z.object({
  document_id: z
    .string()
    .describe('The Google Doc ID (from the URL: docs.google.com/document/d/{ID}/edit).'),
  find: z.string().describe('The exact text string to find in the document.'),
  replace: z.string().describe('The text to replace all found occurrences with.'),
  match_case: z.boolean().optional().describe('Whether to match case exactly (default: true).'),
});

export type ReplaceTextOutput = {
  documentId: string;
  occurrencesChanged: number;
};

export function createReplaceTextTool(
  docs: docs_v1.Docs,
): ToolDefinition<typeof ReplaceTextInput, ReplaceTextOutput> {
  return {
    name: 'docs_replace_text',
    description:
      'Find and replace all occurrences of a text string in a Google Document. ' +
      'Replaces every match in the document body. ' +
      'Returns the number of occurrences changed (0 means the text was not found).',
    inputSchema: ReplaceTextInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        const matchCase = input.match_case ?? true;
        const res = await docs.documents.batchUpdate({
          documentId: input.document_id,
          requestBody: {
            requests: [buildReplaceAllTextRequest(input.find, input.replace, matchCase)],
          },
        });
        const occurrencesChanged = res.data.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;
        return {
          documentId: input.document_id,
          occurrencesChanged,
        };
      } catch (err) {
        if (err instanceof DocsAdapterError) throw err;
        throw mapDocsError(err);
      }
    },
  };
}

// ── docs_delete_content_range ─────────────────────────────────────────────

const DeleteContentRangeInput = z.object({
  document_id: z
    .string()
    .describe('The Google Doc ID (from the URL: docs.google.com/document/d/{ID}/edit).'),
  start_index: z
    .number()
    .int()
    .min(1)
    .describe('Start of the range to delete (inclusive). Get indices from docs_get.'),
  end_index: z
    .number()
    .int()
    .min(2)
    .describe(
      'End of the range to delete (exclusive). Content at [startIndex, endIndex) is removed.',
    ),
});

export type DeleteContentRangeOutput = {
  deleted: boolean;
  documentId: string;
  startIndex: number;
  endIndex: number;
};

export function createDeleteContentRangeTool(
  docs: docs_v1.Docs,
): ToolDefinition<typeof DeleteContentRangeInput, DeleteContentRangeOutput> {
  return {
    name: 'docs_delete_content_range',
    description:
      'Delete a range of content from a Google Document body by index. ' +
      'The range [startIndex, endIndex) is removed — this is irreversible. ' +
      'Use docs_get to find the correct indices before deleting. ' +
      'To delete the whole document, use drive_delete_file from the Drive adapter instead.',
    inputSchema: DeleteContentRangeInput,
    riskLevel: 'destructive',
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
            requests: [buildDeleteContentRangeRequest(input.start_index, input.end_index)],
          },
        });
        return {
          deleted: true,
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
